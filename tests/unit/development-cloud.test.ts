import { afterEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
import * as runtime from "../../src/lib/backend/development-cloud.server";
import { developmentCloudConfig } from "../../src/lib/backend/development-cloud-config";
import { POST, PUT, GET } from "../../src/app/api/development-cloud/route";
import { GET as blockGet } from "../../src/app/api/development-cloud/[id]/blocks/[index]/route";
import { prepare } from "../../src/lib/transfers/prepare";
import {
  uploadPreparedCloud,
  restoreCloud,
} from "../../src/lib/transfers/cloud-client";
import { ScopedStaging } from "../../src/lib/transfers/scoped-store";
import { MemoryStore } from "../fixtures/memory-staging";
import { IndexedStaging } from "../../src/lib/transfers/store";
import type { RestoreSink } from "../../src/lib/transfers/restore";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "99999999-9999-4999-8999-999999999999";
const fileId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const blockId = "55555555-5555-4555-8555-555555555555";
const env = {
  SMART_STORAGE_BACKEND_ENABLED: "true",
  SMART_STORAGE_ENV: "development",
  SMART_STORAGE_TRANSFERS_ENABLED: "false",
  SMART_STORAGE_DEV_CLOUD_ENABLED: "true",
  SMART_STORAGE_DEV_CLOUD_PROJECT_REF: "abcdefghijklmnopqrst",
  SMART_STORAGE_DEV_CLOUD_BUCKET: "private-dev",
  SMART_STORAGE_DEV_CLOUD_PERMIT_KEY: "a".repeat(64),
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefghijklmnopqrstuv",
  APP_ORIGIN: "http://localhost:3000",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("rejects unverified and raw preparation before reservation or Storage", async () => {
  const f = await fixture();
  await expect(
    f.cloud.begin({ ...f.checkpoint, verifiedPreparation: undefined }),
  ).rejects.toThrow("CLOUD_PREPARATION_UNVERIFIED");
  const memory = new MemoryStore();
  const store = new ScopedStaging(
    memory,
    { kind: "account", ownerId: owner },
    () => owner,
  );
  const raw = await prepare(
    new Blob(["raw"]),
    store,
    undefined,
    undefined,
    undefined,
    { originalName: "raw.txt", originalMime: "text/plain" },
  );
  await expect(f.cloud.begin(raw)).rejects.toThrow(
    "CLOUD_COMPRESSED_FILE_REQUIRED",
  );
  expect(f.client.rpc).not.toHaveBeenCalled();
  expect(f.storage).not.toHaveBeenCalled();
});

it("checks actual restoration before a permitted Storage write", async () => {
  const f = await fixture();
  const plan = await f.cloud.begin(f.checkpoint);
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  f.tables.file_blocks[0].original_sha256 = "0".repeat(64);
  await expect(
    f.cloud.write(
      f.checkpoint.id,
      0,
      crypto.randomUUID(),
      body,
      plan.permits[0],
    ),
  ).rejects.toThrow("CLOUD_STORAGE_AUTHORITY_DISABLED");
  expect(f.storage).not.toHaveBeenCalled();
  expect(f.trusted).not.toHaveBeenCalled();
});

it("rejects publication before object access when authority preflight fails", async () => {
  const f = await fixture();
  const cloud = new runtime.DevelopmentCloud(
    { id: owner, client: f.client },
    f.config,
    "ordinary",
    f.trusted,
    f.storage,
    async () => {
      throw Error("UNAUTHENTICATED");
    },
  );
  await expect(
    cloud.publish(f.checkpoint.id, f.checkpoint.manifest),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(f.storage).not.toHaveBeenCalled();
  expect(f.trusted).not.toHaveBeenCalled();
});

it.each(["missing", "expired", "wrong-owner", "wrong-role"])(
  "ordinary publication session rejects %s before bucket access",
  async (failure) => {
    const config = developmentCloudConfig(env)!;
    const getBucket = vi.fn();
    const client = {
      auth: {
        getSession: async () => ({
          data: {
            session:
              failure === "missing" ? null : { access_token: "ordinary" },
          },
          error: null,
        }),
        getClaims: async () => ({
          data: {
            claims: {
              iss: `${config.url}/auth/v1`,
              sub: failure === "wrong-owner" ? other : owner,
              role:
                failure === "wrong-role"
                  ? "ss_dev_cloud_publisher"
                  : "authenticated",
              exp:
                failure === "expired" ? 1 : Math.floor(Date.now() / 1000) + 60,
            },
          },
          error: null,
        }),
      },
      storage: { getBucket },
    } as unknown as SupabaseClient;
    await expect(
      runtime.verifyDevelopmentCloudSession({ id: owner, client }, config),
    ).rejects.toThrow();
    expect(getBucket).not.toHaveBeenCalled();
  },
);

async function fixture(
  options: {
    uploadFailure?: boolean;
    corrupt?: boolean;
    publicationFailure?: boolean;
    authority?: boolean;
    publicationResponseLost?: boolean;
    verificationFailureOnce?: boolean;
  } = {},
) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const config = developmentCloudConfig(env)!;
  const memory = new MemoryStore(),
    staging = new ScopedStaging(
      memory,
      { kind: "account", ownerId: owner },
      () => owner,
    );
  const original = new TextEncoder().encode(
    "independent gzip fixture".repeat(1000),
  );
  const checkpoint = await prepare(
    new Blob([original]),
    staging,
    undefined,
    undefined,
    undefined,
    { originalName: "fixture.txt", originalMime: "text/plain" },
  );
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    upload_sessions: [],
    file_blocks: [],
    transfer_attempts: [],
    files: [],
    file_manifests: [],
  };
  const path = `v1/${owner}/${fileId}/${sessionId}/1/`;
  const file = {
    id: fileId,
    displayName: "fixture.txt",
    originalName: "fixture.txt",
    originalMime: "text/plain",
    category: "document",
    state: "ready",
    originalBytes: String(original.length),
    encodedBytes: String(checkpoint.blocks[0].block.encodedBytes),
    manifestBytes: "1000",
    storedBytes: "2000",
    createdAt: "2026-10-22T00:00:00Z",
    revision: 1,
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "ss_reserve") {
      if (!tables.upload_sessions.length)
        tables.upload_sessions.push({
          id: sessionId,
          file_id: fileId,
          owner_id: owner,
          idempotency_key: checkpoint.id,
          state: "reserved",
          epoch: 1,
          manifest_path: `${path}manifest/${attemptId}.bin`,
          initial_source_sha256: checkpoint.sourceSha256,
          lease_expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      return { data: {}, error: null };
    }
    if (name === "ss_allocate_attempt") {
      if (tables.transfer_attempts.length)
        return { data: null, error: { message: "AMBIGUOUS_ATTEMPT_LOCKED" } };
      const b = checkpoint.blocks[0].block;
      tables.file_blocks.push({
        id: blockId,
        owner_id: owner,
        session_id: sessionId,
        block_index: 0,
        original_offset: 0,
        original_bytes: b.originalBytes,
        encoded_bytes: b.encodedBytes,
        codec: b.codec,
        original_sha256: b.originalSha256,
        encoded_sha256: b.encodedSha256,
      });
      tables.transfer_attempts.push({
        id: attemptId,
        owner_id: owner,
        session_id: sessionId,
        block_id: blockId,
        object_path: `${path}0/${attemptId}.bin`,
        epoch: 1,
        state: "authorized",
        authorized_max_bytes: b.encodedBytes,
        acknowledged_bytes: 0,
        attempted_bytes: 0,
      });
      tables.upload_sessions[0].state = "uploading";
      expect(args.p_encoded_hash).toBe(b.encodedSha256);
      return {
        data: { storageAuthorityEnabled: options.authority !== false },
        error: null,
      };
    }
    if (name === "ss_list_files")
      return { data: tables.files.length ? [file] : [], error: null };
    if (name === "ss_account")
      return {
        data: {
          id: owner,
          needsBootstrap: false,
          usage: {
            quotaBytes: "1048576",
            storedBytes: "2000",
            reservedBytes: "0",
            activeSlots: 0,
            maxSlots: 1,
            historicalOriginalBytes: "23000",
            historicalStoredBytes: "2000",
          },
        },
        error: null,
      };
    throw Error("UNEXPECTED_ORDINARY_RPC");
  });
  const client = {
    rpc,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        single: async () => ({
          data: tables[table].find((row) =>
            Object.entries(filters).every(([k, v]) => row[k] === v),
          ),
          error: null,
        }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const trusted = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const attempt = tables.transfer_attempts[0];
    if (name === "ss_begin_attempt_request") {
      if (attempt.attempted_bytes !== 0) throw Error("REPLAY_BLOCKED");
      attempt.state = "in_flight";
      attempt.attempted_bytes = args.p_body;
    } else if (name === "ss_finish_attempt_request") {
      attempt.acknowledged_bytes = args.p_offset ?? 0;
      if (args.p_offset === null) {
        attempt.state = "ambiguous";
        tables.upload_sessions[0].state = "reconciling";
      }
    } else if (name === "ss_record_observation") attempt.state = "present";
    else if (name === "ss_finalize_verified") {
      if (options.publicationFailure) throw Error("PUBLICATION_FAILED");
      tables.files.push({
        id: fileId,
        owner_id: owner,
        state: "ready",
        manifest_path: args.p_path,
        manifest_sha256: args.p_sha256,
        source_sha256: checkpoint.sourceSha256,
      });
      tables.file_manifests.push({
        owner_id: owner,
        file_id: fileId,
        session_id: sessionId,
        object_path: args.p_path,
        sha256: args.p_sha256,
        manifest: args.p_manifest,
      });
      tables.upload_sessions[0].state = "completed";
      return file;
    } else throw Error("UNEXPECTED_TRUSTED_RPC");
  });
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  let verificationFailed = false;
  const storage = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer ordinary-fixture",
      "x-upsert": "false",
    });
    expect(init?.redirect).toBe("error");
    const key = String(url).split("/object/private-dev/")[1];
    if (init?.method === "POST") {
      if (options.uploadFailure) return new Response(null, { status: 503 });
      if (objects.has(key)) return new Response(null, { status: 409 });
      objects.set(key, (init.body as Uint8Array<ArrayBuffer>).slice());
      return Response.json({});
    }
    const bytes = objects.get(key);
    if (
      options.verificationFailureOnce &&
      !verificationFailed &&
      key.includes("/0/")
    ) {
      verificationFailed = true;
      return new Response(null, { status: 503 });
    }
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(
      options.corrupt && key.includes("/0/")
        ? new Uint8Array(bytes.length).fill(7)
        : bytes,
    );
  });
  const cloud = new runtime.DevelopmentCloud(
    { id: owner, client },
    config,
    "ordinary-fixture",
    trusted,
    storage,
  );
  vi.spyOn(runtime, "developmentCloudRuntime").mockResolvedValue(cloud);
  const api = vi.fn<typeof fetch>(async (url, init) => {
    const full = `http://localhost:3000${url}`;
    const request = new Request(full, {
      ...init,
      headers: { ...init?.headers, Origin: env.APP_ORIGIN },
    });
    if (String(url).includes("/blocks/")) {
      const parts = String(url).split("/");
      return blockGet(request, {
        params: Promise.resolve({ id: parts[3], index: parts[5] }),
      });
    }
    if (init?.method === "POST") {
      const action = JSON.parse(String(init.body)).action;
      const response = await POST(request);
      if (
        options.publicationResponseLost &&
        action === "publish" &&
        response.ok
      )
        throw Error("RESPONSE_LOST");
      return response;
    }
    return init?.method === "PUT" ? PUT(request) : GET(request);
  });
  vi.stubGlobal("fetch", api);
  return {
    cloud,
    config,
    client,
    checkpoint,
    staging,
    memory,
    original,
    storage,
    trusted,
    tables,
    objects,
    api,
  };
}
function output() {
  const chunks: Uint8Array[] = [];
  const sink: RestoreSink = {
    write: vi.fn(async (bytes) => {
      chunks.push(bytes.slice());
    }),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return { sink, chunks };
}

it("runs client -> real application routes -> Storage adapter -> trusted publication -> dashboard -> verified local restore", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  const result = await uploadPreparedCloud(f.checkpoint, f.staging, signal);
  expect(result.phase).toBe("completed");
  expect((await f.cloud.listing()).files[0].id).toBe(fileId);
  f.memory.blobs.clear();
  const out = output();
  expect((await restoreCloud(fileId, out.sink, signal)).verified).toBe(true);
  expect(
    createHash("sha256").update(Buffer.concat(out.chunks)).digest("hex"),
  ).toBe(createHash("sha256").update(f.original).digest("hex"));
  expect(Buffer.concat(out.chunks)).toEqual(Buffer.from(f.original));
  expect(out.sink.commit).toHaveBeenCalledOnce();
  expect(out.sink.abort).not.toHaveBeenCalled();
});
it("retains ambiguous checkpoint and liabilities after upload failure without automatic retry", async () => {
  const f = await fixture({ uploadFailure: true });
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, new AbortController().signal),
  ).rejects.toThrow("CLOUD_OBJECT_REQUEST_FAILED");
  expect((await f.staging.load(f.checkpoint.id)).phase).toBe("ambiguous");
  expect(f.storage).toHaveBeenCalledOnce();
  expect(f.tables.files).toHaveLength(0);
  await expect(
    uploadPreparedCloud(
      await f.staging.load(f.checkpoint.id),
      f.staging,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.storage).toHaveBeenCalledOnce();
});
it("rejects corrupt provider bytes and never publishes or exposes ready metadata", async () => {
  const f = await fixture({ corrupt: true });
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, new AbortController().signal),
  ).rejects.toThrow("ENCODED_INTEGRITY");
  expect(f.tables.files).toHaveLength(0);
  expect(
    f.trusted.mock.calls.some(([name]) => name === "ss_finalize_verified"),
  ).toBe(false);
});
it("publication failure preserves ambiguous state and does not fabricate dashboard success", async () => {
  const f = await fixture({ publicationFailure: true });
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, new AbortController().signal),
  ).rejects.toThrow("REQUEST_FAILED");
  expect((await f.staging.load(f.checkpoint.id)).phase).toBe("ambiguous");
  expect((await f.cloud.listing()).files).toHaveLength(0);
});
it("denies another account's manifest and blocks before any Storage download", async () => {
  const f = await fixture();
  await uploadPreparedCloud(
    f.checkpoint,
    f.staging,
    new AbortController().signal,
  );
  const cloud = new runtime.DevelopmentCloud(
    { id: other, client: f.client },
    f.config,
    "other-ordinary",
    f.trusted,
    f.storage,
  );
  f.storage.mockClear();
  await expect(cloud.download(fileId, 0)).rejects.toThrow("NOT_FOUND");
  expect(f.storage).not.toHaveBeenCalled();
});
it("never overrides disabled allocation authority and rejects a direct write without its server permit", async () => {
  const f = await fixture({ authority: false });
  await expect(f.cloud.begin(f.checkpoint)).rejects.toThrow(
    "CLOUD_STORAGE_AUTHORITY_DISABLED",
  );
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  await expect(
    f.cloud.write(f.checkpoint.id, 0, crypto.randomUUID(), body, ""),
  ).rejects.toThrow("CLOUD_STORAGE_AUTHORITY_DISABLED");
  expect(f.storage).not.toHaveBeenCalled();
  expect(f.trusted).not.toHaveBeenCalled();
});
it("fails closed outside development, on mismatched project or absent bucket configuration", () => {
  expect(developmentCloudConfig({})).toBeNull();
  for (const change of [
    { SMART_STORAGE_ENV: "production" },
    { SMART_STORAGE_DEV_CLOUD_PROJECT_REF: "z".repeat(20) },
    { SMART_STORAGE_DEV_CLOUD_BUCKET: "" },
    { SMART_STORAGE_TRANSFERS_ENABLED: "true" },
  ])
    expect(() => developmentCloudConfig({ ...env, ...change })).toThrow();
});
it("disabled routes and cross-origin mutations stop before runtime or body dispatch", async () => {
  const spy = vi.spyOn(runtime, "developmentCloudRuntime");
  vi.stubEnv("SMART_STORAGE_DEV_CLOUD_ENABLED", "false");
  expect(
    (
      await POST(
        new Request("http://localhost:3000/api/development-cloud", {
          method: "POST",
        }),
      )
    ).status,
  ).toBe(503);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  expect(
    (
      await PUT(
        new Request("http://localhost:3000/api/development-cloud", {
          method: "PUT",
          headers: { Origin: "https://other.invalid" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(spy).not.toHaveBeenCalled();
});
it("recovers a lost publication response through a read-only receipt, never reuploading", async () => {
  const f = await fixture({ publicationResponseLost: true });
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, new AbortController().signal),
  ).rejects.toThrow("RESPONSE_LOST");
  const uncertain = await f.staging.load(f.checkpoint.id);
  expect(uncertain.phase).toBe("ambiguous");
  expect(f.tables.files).toHaveLength(1);
  f.api.mockClear();
  f.storage.mockClear();
  f.trusted.mockClear();
  const recovered = await uploadPreparedCloud(
    uncertain,
    f.staging,
    new AbortController().signal,
  );
  expect(recovered.phase).toBe("completed");
  expect(f.api).toHaveBeenCalledOnce();
  expect(String(f.api.mock.calls[0][0])).toContain("?key=");
  expect(f.storage.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
    true,
  );
  expect(f.trusted).not.toHaveBeenCalled();
});
it("permanent request fencing prevents a repeated create even with a valid permit", async () => {
  const f = await fixture(),
    plan = await f.cloud.begin(f.checkpoint);
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  await f.cloud.write(
    f.checkpoint.id,
    0,
    crypto.randomUUID(),
    body,
    plan.permits[0],
  );
  await expect(
    f.cloud.write(
      f.checkpoint.id,
      0,
      crypto.randomUUID(),
      body,
      plan.permits[0],
    ),
  ).rejects.toThrow("UPLOAD_RECOVERY_REQUIRED");
  expect(f.storage).toHaveBeenCalledOnce();
});
it("freshly verified project/account claims and private bounded bucket must agree before data operations", async () => {
  const config = developmentCloudConfig(env)!;
  const bucket = {
    id: config.bucket,
    public: false,
    file_size_limit: config.maximumBytes,
    allowed_mime_types: ["application/octet-stream"],
  };
  const claims = {
    iss: `${config.url}/auth/v1`,
    sub: owner,
    role: "authenticated",
    exp: Date.now() / 1000 + 3600,
  };
  const getBucket = vi.fn(async () => ({ data: bucket, error: null }));
  const getClaims = vi.fn(async () => ({ data: { claims }, error: null }));
  const context = {
    id: owner,
    client: {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: "ordinary" } },
          error: null,
        }),
        getClaims,
      },
      storage: { getBucket },
    } as unknown as SupabaseClient,
  };
  await expect(
    runtime.verifyDevelopmentCloudSession(context, config),
  ).resolves.toBe("ordinary");
  for (const altered of [
    { ...claims, iss: "https://other.invalid/auth/v1" },
    { ...claims, sub: other },
    { ...claims, role: "service_role" },
    { ...claims, exp: 1 },
  ]) {
    getBucket.mockClear();
    getClaims.mockResolvedValueOnce({ data: { claims: altered }, error: null });
    await expect(
      runtime.verifyDevelopmentCloudSession(context, config),
    ).rejects.toThrow("CLOUD_PROJECT_ACCOUNT_MISMATCH");
    expect(getBucket).not.toHaveBeenCalled();
  }
  getBucket.mockResolvedValueOnce({
    data: { ...bucket, public: true },
    error: null,
  });
  await expect(
    runtime.verifyDevelopmentCloudSession(context, config),
  ).rejects.toThrow("CLOUD_PRIVATE_BUCKET_UNVERIFIED");
});

it("a corrupted authenticated download aborts its destination without committing bytes", async () => {
  const f = await fixture();
  await uploadPreparedCloud(
    f.checkpoint,
    f.staging,
    new AbortController().signal,
  );
  const key = [...f.objects.keys()].find((value) => value.includes("/0/"))!;
  const bytes = f.objects.get(key)!.slice();
  bytes[0] ^= 1;
  f.objects.set(key, bytes);
  const out = output();
  await expect(
    restoreCloud(fileId, out.sink, new AbortController().signal),
  ).rejects.toThrow("ENCODED_INTEGRITY");
  expect(out.sink.abort).toHaveBeenCalledOnce();
  expect(out.sink.commit).not.toHaveBeenCalled();
});

it("server rejects publication metadata that differs from the authorized block", async () => {
  const f = await fixture(),
    plan = await f.cloud.begin(f.checkpoint);
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  await f.cloud.write(
    f.checkpoint.id,
    0,
    crypto.randomUUID(),
    body,
    plan.permits[0],
  );
  const manifest = structuredClone(f.checkpoint.manifest!);
  manifest.blocks[0].originalSha256 = "0".repeat(64);
  await expect(f.cloud.publish(f.checkpoint.id, manifest)).rejects.toThrow(
    "CLOUD_MEMBERSHIP_INVALID",
  );
  expect(f.tables.files).toHaveLength(0);
  expect([...f.objects.keys()].some((key) => key.includes("/manifest/"))).toBe(
    false,
  );
});

it("restricted worker adapter accepts only same-project verified RPC role and never uses its credential for Storage", async () => {
  const config = developmentCloudConfig(env)!;
  const claims = {
    iss: `${config.url}/auth/v1`,
    role: "ss_dev_cloud_rpc",
    exp: Date.now() / 1000 + 3600,
  };
  const getClaims = vi.fn(async () => ({ data: { claims }, error: null }));
  const context = {
    id: owner,
    client: { auth: { getClaims } } as unknown as SupabaseClient,
  };
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ state: "ready" }),
  );
  const variables = {
    SMART_STORAGE_DEV_CLOUD_RPC_ROLE: claims.role,
    SMART_STORAGE_DEV_CLOUD_RPC_TOKEN: "synthetic-worker",
  };
  const authority = runtime.developmentCloudAuthority(
    context,
    config,
    variables,
    http,
  );
  await authority.trusted("ss_finalize_verified", { p_session: sessionId });
  expect(getClaims).toHaveBeenCalledWith("synthetic-worker");
  expect(http.mock.calls[0][0]).toBe(
    `${config.url}/rest/v1/rpc/ss_finalize_verified`,
  );
  expect(http.mock.calls[0][1]?.headers).toMatchObject({
    Authorization: "Bearer synthetic-worker",
  });
  expect(http.mock.calls[0][1]?.redirect).toBe("error");
  http.mockClear();
  await expect(authority.trusted("arbitrary_function", {})).rejects.toThrow(
    "CLOUD_TRUSTED_RPC_UNAVAILABLE",
  );
  for (const role of ["service_role", "authenticated", "postgres", "anon"]) {
    const invalid = runtime.developmentCloudAuthority(
      context,
      config,
      { ...variables, SMART_STORAGE_DEV_CLOUD_RPC_ROLE: role },
      http,
    );
    await expect(invalid.ensureTrusted()).rejects.toThrow(
      "CLOUD_TRUSTED_RPC_UNAVAILABLE",
    );
  }
  getClaims.mockResolvedValueOnce({
    data: { claims: { ...claims, iss: "https://other.invalid/auth/v1" } },
    error: null,
  });
  await expect(authority.ensureTrusted()).rejects.toThrow(
    "CLOUD_TRUSTED_RPC_UNAVAILABLE",
  );
  expect(http).not.toHaveBeenCalled();
});

it("missing restricted authority stops before reservation allocation or Storage dispatch", async () => {
  const f = await fixture();
  const ensure = vi.fn(async () => {
    throw Error("CLOUD_TRUSTED_RPC_UNAVAILABLE");
  });
  const cloud = new runtime.DevelopmentCloud(
    { id: owner, client: f.client },
    f.config,
    "ordinary",
    f.trusted,
    f.storage,
    ensure,
  );
  await expect(cloud.begin(f.checkpoint)).rejects.toThrow(
    "CLOUD_TRUSTED_RPC_UNAVAILABLE",
  );
  expect(f.tables.upload_sessions).toHaveLength(0);
  expect(f.storage).not.toHaveBeenCalled();
});

it("continues verification of an acknowledged block without allocating or uploading it again", async () => {
  const f = await fixture({ verificationFailureOnce: true });
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, new AbortController().signal),
  ).rejects.toThrow("CLOUD_OBJECT_REQUEST_FAILED");
  const acknowledged = await f.staging.load(f.checkpoint.id);
  expect(acknowledged.blocks[0].phase).toBe("acknowledged");
  f.storage.mockClear();
  const completed = await uploadPreparedCloud(
    acknowledged,
    f.staging,
    new AbortController().signal,
  );
  expect(completed.phase).toBe("completed");
  expect(
    f.storage.mock.calls.filter(
      ([url, init]) => init?.method === "POST" && String(url).includes("/0/"),
    ),
  ).toHaveLength(0);
  expect(
    f.storage.mock.calls.filter(
      ([url, init]) =>
        init?.method === "POST" && String(url).includes("/manifest/"),
    ),
  ).toHaveLength(1);
  expect(f.tables.transfer_attempts).toHaveLength(1);
});

it("denied manifest retrieval aborts the local output before decompression starts", async () => {
  const f = await fixture();
  const out = output();
  await expect(
    restoreCloud(fileId, out.sink, new AbortController().signal),
  ).rejects.toThrow("NOT_FOUND");
  expect(out.sink.abort).toHaveBeenCalledOnce();
  expect(out.sink.write).not.toHaveBeenCalled();
  expect(out.sink.commit).not.toHaveBeenCalled();
  expect(f.storage).not.toHaveBeenCalled();
});

it("project/bucket namespaces keep cloud checkpoints separate from the existing account store", async () => {
  const open = vi
    .spyOn(IndexedStaging, "open")
    .mockRejectedValue(Error("fixture-stop"));
  const scope = { kind: "account" as const, ownerId: owner };
  for (const namespace of [
    undefined,
    "cloud-project-one-bucket",
    "cloud-project-two-bucket",
  ]) {
    await expect(
      ScopedStaging.open(scope, () => owner, namespace),
    ).rejects.toThrow("fixture-stop");
  }
  expect(new Set(open.mock.calls.map(([name]) => name)).size).toBe(3);
  open.mockClear();
  await expect(
    ScopedStaging.open(scope, () => owner, "../other"),
  ).rejects.toThrow("STAGING_NAMESPACE_INVALID");
  await expect(
    ScopedStaging.open({ kind: "anonymous" }, () => null, "cloud-project"),
  ).rejects.toThrow("STAGING_NAMESPACE_INVALID");
  expect(open).not.toHaveBeenCalled();
});

it("repeated receipts reconcile without publishing or accounting again", async () => {
  const f = await fixture({ publicationResponseLost: true });
  const signal = new AbortController().signal;
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, signal),
  ).rejects.toThrow();
  expect((await f.staging.load(f.checkpoint.id)).publication).toBe(
    "dispatched",
  );
  const calls = f.trusted.mock.calls.length;
  const records = f.tables.files.length;
  for (let i = 0; i < 2; i++)
    expect(
      (await uploadPreparedCloud(f.checkpoint, f.staging, signal)).phase,
    ).toBe("completed");
  expect(f.trusted).toHaveBeenCalledTimes(calls);
  expect(f.tables.files).toHaveLength(records);
  expect(records).toBe(1);
});

it("rejects a receipt for another current owner before remote observation", async () => {
  const f = await fixture();
  await expect(f.cloud.receipt(f.checkpoint.id, other)).rejects.toThrow(
    "OWNER_FORBIDDEN",
  );
  expect(f.storage).not.toHaveBeenCalled();
  expect(f.trusted).not.toHaveBeenCalled();
});

it.each(["session_id", "object_path"])(
  "denies receipt with mismatched %s",
  async (field) => {
    const f = await fixture({ publicationResponseLost: true });
    const signal = new AbortController().signal;
    await expect(
      uploadPreparedCloud(f.checkpoint, f.staging, signal),
    ).rejects.toThrow();
    f.tables.file_manifests[0][field] =
      field === "session_id" ? other : "foreign/path";
    const calls = f.trusted.mock.calls.length;
    await expect(
      uploadPreparedCloud(f.checkpoint, f.staging, signal),
    ).rejects.toThrow();
    expect((await f.staging.load(f.checkpoint.id)).phase).toBe("ambiguous");
    expect(f.trusted).toHaveBeenCalledTimes(calls);
  },
);

it("publication rejection remains uncertain and cannot automatically resend", async () => {
  const f = await fixture({ publicationFailure: true });
  const signal = new AbortController().signal;
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, signal),
  ).rejects.toThrow();
  const calls = f.trusted.mock.calls.length;
  await expect(
    uploadPreparedCloud(f.checkpoint, f.staging, signal),
  ).rejects.toThrow();
  expect(f.trusted).toHaveBeenCalledTimes(calls);
  expect(f.tables.files).toHaveLength(0);
  expect((await f.staging.load(f.checkpoint.id)).phase).toBe("ambiguous");
});

it.each(["logout", "switch"])(
  "denies a delayed receipt after %s and allows fresh same-owner reconciliation",
  async (event) => {
    const f = await fixture({ publicationResponseLost: true });
    const signal = new AbortController().signal;
    await expect(
      uploadPreparedCloud(f.checkpoint, f.staging, signal),
    ).rejects.toThrow();
    let current: string | null = owner;
    const scoped = new ScopedStaging(
      f.memory,
      { kind: "account", ownerId: owner },
      () => current,
    );
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await f.api(...args);
      if (String(args[0]).includes("?key="))
        current = event === "logout" ? null : other;
      return response;
    });
    await expect(
      uploadPreparedCloud(f.checkpoint, scoped, signal),
    ).rejects.toThrow("STAGING_ACCOUNT_CHANGED");
    expect((await f.memory.load(f.checkpoint.id)).phase).toBe("ambiguous");
    current = owner;
    vi.stubGlobal("fetch", f.api);
    expect(
      (await uploadPreparedCloud(f.checkpoint, scoped, signal)).phase,
    ).toBe("completed");
    expect(f.tables.files).toHaveLength(1);
  },
);

it.each([
  "owner_id",
  "encoded_sha256",
  "original_sha256",
  "codec",
  "original_offset",
  "encoded_bytes",
])("invalidates an issued permit when allocation %s changes", async (field) => {
  const f = await fixture();
  const plan = await f.cloud.begin(f.checkpoint);
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  f.tables.file_blocks[0][field] =
    field === "owner_id"
      ? other
      : field.endsWith("bytes") || field.endsWith("offset")
        ? 999
        : "tampered";
  await expect(
    f.cloud.write(
      f.checkpoint.id,
      0,
      crypto.randomUUID(),
      body,
      plan.permits[0],
    ),
  ).rejects.toThrow();
  expect(f.storage).not.toHaveBeenCalled();
  expect(f.trusted).not.toHaveBeenCalled();
});
it("rejects substituted payload before dispatch even with the valid allocation permit", async () => {
  const f = await fixture();
  const plan = await f.cloud.begin(f.checkpoint);
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  body[0] ^= 1;
  await expect(
    f.cloud.write(
      f.checkpoint.id,
      0,
      crypto.randomUUID(),
      body,
      plan.permits[0],
    ),
  ).rejects.toThrow("STAGED_INTEGRITY");
  expect(f.storage).not.toHaveBeenCalled();
  expect(f.trusted).not.toHaveBeenCalled();
});
it("rejects a permit replay through a different authenticated owner", async () => {
  const f = await fixture();
  const plan = await f.cloud.begin(f.checkpoint);
  const foreign = new runtime.DevelopmentCloud(
    { id: other, client: f.client },
    f.config,
    "ordinary",
    f.trusted,
    f.storage,
  );
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  await expect(
    foreign.write(
      f.checkpoint.id,
      0,
      crypto.randomUUID(),
      body,
      plan.permits[0],
    ),
  ).rejects.toThrow("NOT_FOUND");
  expect(f.storage).not.toHaveBeenCalled();
});

it("requires the whole-original digest after valid compressed and restored-block integrity", async () => {
  const f = await fixture();
  const plan = await f.cloud.begin(f.checkpoint);
  const body = new Uint8Array(
    await (await f.staging.block(f.checkpoint.id, 0)).arrayBuffer(),
  );
  await f.cloud.write(
    f.checkpoint.id,
    0,
    crypto.randomUUID(),
    body,
    plan.permits[0],
  );
  const manifest = structuredClone(f.checkpoint.manifest!);
  manifest.originalSha256 = "0".repeat(64);
  f.tables.upload_sessions[0].initial_source_sha256 = manifest.originalSha256;
  await expect(f.cloud.publish(f.checkpoint.id, manifest)).rejects.toThrow(
    "WHOLE_FILE_INTEGRITY",
  );
  expect(f.tables.files).toHaveLength(0);
  expect([...f.objects.keys()].some((key) => key.includes("/manifest/"))).toBe(
    false,
  );
});
