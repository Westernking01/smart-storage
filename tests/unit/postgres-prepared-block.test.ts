import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  expect,
  it,
  vi,
} from "vitest";
vi.mock("server-only", () => ({}));
import { PostgresPreparedBlockAuthority } from "../../src/lib/gateway/postgres-prepared-block.server";

const id = (prefix: string) => `${prefix}0000000-0000-0000-0000-000000000001`;
const owner = "00000000-0000-4000-8000-000000000001",
  executor = id("6"),
  request = id("5"),
  resource = id("7");
const scope = {
  ownerId: owner,
  checkpointId: "checkpoint",
  manifestSha256: "b".repeat(64),
  blockIndex: 0,
};
let db: PGlite;
let unclaimedSnapshot: Blob | File;
const release = vi.fn();
const pool = {
  connect: async () => ({
    // Only the exact runtime environment probe is mocked; all authority SQL runs.
    query: async (sql: string, values?: unknown[]) =>
      sql.includes("AS allowed")
        ? { rows: [{ allowed: true }] }
        : db.query<Record<string, unknown>>(sql, values),
    release,
  }),
};
const authority = () =>
  new PostgresPreparedBlockAuthority(pool, async () => ({
    ownerId: owner,
    executorId: executor,
  }));
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      (await readFile(new URL(name, dir), "utf8")).replace(/^\uFEFF/, ""),
    );
  await db.exec(
    await readFile(
      new URL("../database/gateway-claims-fixture.sql", import.meta.url),
      "utf8",
    ).then((text) =>
      text.split("00000000-0000-0000-0000-").join("00000000-0000-4000-8000-"),
    ),
  );
  unclaimedSnapshot = await db.dumpDataDir();
  await db.query("select public.ss_gateway_claim_v1($1,$2,$3,8,$4)", [
    owner,
    id("4"),
    request,
    executor,
  ]);
  const path = (
    await db.query<{ object_path: string }>(
      "select object_path from public.transfer_attempts where id=$1",
      [id("4")],
    )
  ).rows[0].object_path;
  await db.query(
    "select public.ss_gateway_register_resource_v1($1,$2,$3,1,'object',$4,$5,8)",
    [
      owner,
      request,
      resource,
      path,
      JSON.stringify({
        namespace: "fixture",
        uploadId: null,
        version: null,
        generation: null,
      }),
    ],
  );
}, 120000);
beforeEach(async () => {
  await db.query(
    "insert into app_private.prepared_block_bindings values($1,$2,$3,0,$4,$5)",
    [owner, scope.checkpointId, scope.manifestSha256, request, resource],
  );
});
afterEach(async () => {
  // Restore a fresh fixture snapshot, including consumed grants, without touching persistent databases.
  await db.close();
  db = await PGlite.create({ loadDataDir: await snapshot });
});
let snapshot: Promise<Blob | File>;
beforeAll(async () => {
  snapshot = db.dumpDataDir();
  await snapshot;
});
afterAll(async () => {
  await db?.close();
});

it("resolves authoritative membership and consumes once across new adapter instances", async () => {
  const result = await authority().resolve(scope);
  expect(result.intent).toMatchObject({
    ownerId: owner,
    requestId: request,
    resourceId: resource,
    operation: "single-object-create",
  });
  expect(result.reservation.requiredExposureBytes).toBe("131080");
  await authority().consumeDispatch(result.intent);
  await expect(authority().consumeDispatch(result.intent)).rejects.toThrow();
  await expect(authority().resolve(scope)).rejects.toThrow();
  expect(
    (
      await db.query<{ held_bytes: number }>(
        "select held_bytes from public.upload_sessions where id=$1",
        [id("2")],
      )
    ).rows[0].held_bytes,
  ).toBe(131080);
});
it("rejects caller owner assertions before connecting", async () => {
  const connect = vi.fn(pool.connect);
  const a = new PostgresPreparedBlockAuthority({ connect }, async () => ({
    ownerId: owner,
    executorId: executor,
  }));
  await expect(
    a.resolve({ ...scope, ownerId: "90000000-0000-4000-8000-000000000001" }),
  ).rejects.toThrow("FORBIDDEN");
  expect(connect).not.toHaveBeenCalled();
});
it.each([
  { checkpointId: "missing" },
  { manifestSha256: "c".repeat(64) },
  { blockIndex: 1 },
])("denies missing or mismatched scope %j", async (patch) => {
  await expect(authority().resolve({ ...scope, ...patch })).rejects.toThrow();
});
it.each([
  "update public.upload_sessions set lease_expires_at=clock_timestamp()-interval '1 second'",
  "update public.upload_sessions set state='cancelling'",
  "update public.user_usage set reserved_bytes=0",
  "update public.transfer_attempts set expires_at=clock_timestamp()-interval '1 second'",
])("rechecks changed reservation at consumption: %s", async (sql) => {
  const result = await authority().resolve(scope);
  await db.exec(sql);
  await expect(authority().consumeDispatch(result.intent)).rejects.toThrow();
  expect(
    (
      await db.query<{ dispatched_at: unknown }>(
        "select dispatched_at from app_private.gateway_requests where request_id=$1",
        [request],
      )
    ).rows[0].dispatched_at,
  ).toBeNull();
});
it("rejects forged object identity without consuming", async () => {
  const result = await authority().resolve(scope);
  await expect(
    authority().consumeDispatch({ ...result.intent, path: "forged" }),
  ).rejects.toThrow("IDENTITY_MISMATCH");
  await authority().consumeDispatch(result.intent);
});
it("denies replay after a committed dispatch loses its acknowledgment", async () => {
  const result = await authority().resolve(scope);
  const uncertain = new PostgresPreparedBlockAuthority(
    {
      connect: async () => {
        const client = await pool.connect();
        return {
          ...client,
          query: async (sql: string, values?: unknown[]) => {
            const response = await client.query(sql, values);
            if (sql === "COMMIT") throw new Error("ACK_LOST");
            return response;
          },
        };
      },
    },
    async () => ({ ownerId: owner, executorId: executor }),
  );
  await expect(uncertain.consumeDispatch(result.intent)).rejects.toThrow(
    "ACK_LOST",
  );
  await expect(authority().consumeDispatch(result.intent)).rejects.toThrow();
  expect(release).toHaveBeenCalledWith(expect.any(Error));
});
it("serializes competing consumers to one grant (single-connection fixture)", async () => {
  const result = await authority().resolve(scope);
  let tail = Promise.resolve();
  const serialPool = {
    connect: async () => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      const client = await pool.connect();
      return { ...client, release: () => unlock() };
    },
  };
  const create = () =>
    new PostgresPreparedBlockAuthority(serialPool, async () => ({
      ownerId: owner,
      executorId: executor,
    }));
  const outcomes = await Promise.allSettled([
    create().consumeDispatch(result.intent),
    create().consumeDispatch(result.intent),
  ]);
  expect(outcomes.map((value) => value.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
});
it("keeps bindings immutable and private with executor-only RPC authority", async () => {
  await expect(
    db.exec(
      "update app_private.prepared_block_bindings set checkpoint_id='other'",
    ),
  ).rejects.toThrow("PREPARED_BINDING_IMMUTABLE");
  await db.exec("set role authenticated");
  await expect(
    db.query("select public.ss_prepared_block_resolve_v1($1,$2,$3,0,$4)", [
      owner,
      "checkpoint",
      scope.manifestSha256,
      executor,
    ]),
  ).rejects.toThrow("permission denied");
  await expect(
    db.exec("select * from app_private.prepared_block_bindings"),
  ).rejects.toThrow("permission denied");
  await db.exec("reset role");
});

// Registration uses the same disposable durable fixture and restricted adapter.
it("registration validates and commits immutable authority, rejecting duplicates", async () => {
  await db.close();
  db = await PGlite.create({ loadDataDir: unclaimedSnapshot });
  const { PostgresPreparedManifestRegistration } =
    await import("../../src/lib/gateway/postgres-prepared-manifest.server");
  const registration = new PostgresPreparedManifestRegistration(
    pool,
    async () => ({ ownerId: owner, executorId: executor }),
  );
  const block = {
    index: 0,
    offset: 0,
    originalBytes: 8,
    encodedBytes: 8,
    codec: "raw",
    originalSha256: "a".repeat(64),
    encodedSha256: "a".repeat(64),
  };
  const checkpoint = {
    version: 1,
    id: "12345678-1234-4123-8123-123456789012",
    revision: 0,
    ownerId: owner,
    originalBytes: 8,
    sourceSha256: "a".repeat(64),
    blockSize: 65536,
    phase: "prepared",
    blocks: [
      {
        block,
        phase: "prepared",
        attemptedBytes: 0,
        acknowledgedBytes: 0,
        attemptId: null,
      },
    ],
    manifest: {
      format: "compression-spike",
      version: 1,
      blockSize: 65536,
      originalBytes: 8,
      originalSha256: "a".repeat(64),
      blocks: [block],
    },
  };
  const input = {
    checkpoint,
    reservation: {
      sessionId: id("2"),
      fileId: id("1"),
      bindings: [
        { attemptId: id("4"), requestId: request, resourceId: resource },
      ],
    },
  };
  await expect(
    registration.register({
      ...input,
      checkpoint: {
        ...checkpoint,
        ownerId: "90000000-0000-4000-8000-000000000001",
      },
    }),
  ).rejects.toThrow("OWNER_FORBIDDEN");
  await expect(
    registration.register({
      ...input,
      checkpoint: {
        ...checkpoint,
        manifest: { ...checkpoint.manifest, version: 2 },
      },
    }),
  ).rejects.toThrow();
  await db.exec("update public.user_usage set reserved_bytes=0");
  await expect(registration.register(input)).rejects.toThrow(
    "QUOTA_INSUFFICIENT",
  );
  expect(
    (await db.query("select * from app_private.prepared_block_plans")).rows,
  ).toHaveLength(0);
  await db.exec("update public.user_usage set reserved_bytes=262160");
  await db.exec(
    "update public.transfer_attempts set expires_at=clock_timestamp()-interval '1 second' where id='40000000-0000-0000-0000-000000000001'",
  );
  await expect(registration.register(input)).rejects.toThrow("SESSION_BLOCKED");
  await db.exec(
    "update public.transfer_attempts set expires_at=clock_timestamp()+interval '1 day'",
  );
  let tail = Promise.resolve();
  const serialPool = {
    connect: async () => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((r) => {
        unlock = r;
      });
      await previous;
      const client = await pool.connect();
      return { ...client, release: () => unlock() };
    },
  };
  const create = () =>
    new PostgresPreparedManifestRegistration(serialPool, async () => ({
      ownerId: owner,
      executorId: executor,
    }));
  const results = await Promise.allSettled([
    create().register(input),
    create().register(input),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  await expect(registration.register(input)).rejects.toThrow();
  expect(
    (await db.query("select * from app_private.prepared_block_plans")).rows,
  ).toHaveLength(1);
  const result = results.find((r) => r.status === "fulfilled");
  if (result?.status !== "fulfilled") throw new Error("REGISTRATION_MISSING");
  await expect(
    authority().resolve({
      ownerId: owner,
      checkpointId: checkpoint.id,
      manifestSha256: result.value.manifestSha256,
      blockIndex: 0,
    }),
  ).resolves.toBeDefined();
});
