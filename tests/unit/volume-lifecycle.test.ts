import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
vi.mock("server-only", () => ({}));
import {
  VolumeLifecycle,
  type VolumeDatabase,
} from "../../src/lib/gateway/volume-lifecycle.server";
import { LocalDiskTransport } from "../../src/lib/gateway/local-disk-transport.server";
import { restore } from "../../src/lib/transfers/restore";
import type { Manifest } from "../../src/lib/transfers/format";
import { prepare } from "../../src/lib/transfers/prepare";
import type { Checkpoint } from "../../src/lib/transfers/checkpoint";
import type { StagingStore } from "../../src/lib/transfers/store";
import {
  uploadPreparedVolume,
  restoreVolume,
} from "../../src/lib/transfers/volume-client";
const auth = vi.hoisted(() => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
}));
vi.mock("../../src/lib/backend/operations", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/backend/operations")>();
  return {
    ...original,
    ownerContext: async () => {
      if (!auth.id) throw new original.BackendError("UNAUTHENTICATED", 401);
      return { id: auth.id };
    },
  };
});
vi.mock("../../src/lib/gateway/volume-runtime.server", () => ({
  volumeRuntime: async () => lifecycle,
}));
import {
  volumeGet,
  volumePost,
  volumeBlock,
} from "../../src/lib/gateway/volume-http.server";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const V = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let db: PGlite,
  root: string,
  lifecycle: VolumeLifecycle,
  disk: LocalDiskTransport;
const database: VolumeDatabase = {
  async command(owner, action, id, data = {}) {
    await db.exec("savepoint command");
    try {
      const result = (
        await db.query<{ value: unknown }>(
          "select public.ss_volume_command($1,$2,$3,$4::jsonb) value",
          [owner, action, id, JSON.stringify(data)],
        )
      ).rows[0].value;
      await db.exec("release savepoint command");
      return result;
    } catch (error) {
      await db.exec("rollback to savepoint command;release savepoint command");
      throw error;
    }
  },
};
function fixture(
  original = Buffer.from("exact restoration ".repeat(1000)),
  compressed = true,
) {
  const encoded = compressed ? gzipSync(original) : original;
  const manifest: Manifest = {
    format: "compression-spike",
    version: 1,
    blockSize: 8388608,
    originalBytes: original.length,
    originalSha256: hash(original),
    blocks: [
      {
        index: 0,
        offset: 0,
        originalBytes: original.length,
        encodedBytes: encoded.length,
        codec: compressed ? "gzip" : "raw",
        originalSha256: hash(original),
        encodedSha256: hash(encoded),
      },
    ],
  };
  return {
    original,
    encoded,
    manifest,
    input: {
      key: "volume_upload_0001",
      metadata: { originalName: "fixture.bin", originalMime: null },
      manifest,
    },
  };
}
async function* source(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i += 65536)
    yield bytes.subarray(i, i + 65536);
}
async function usage() {
  return (
    await db.query<{
      stored_bytes: number;
      reserved_bytes: number;
      active_slots: number;
    }>(
      "select stored_bytes,reserved_bytes,active_slots from public.user_usage where owner_id=$1",
      [A],
    )
  ).rows[0];
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
 grant usage on schema auth to anon,authenticated,service_role;
 insert into auth.users values('${A}'),('${B}');`);
  for (const name of (await readdir("supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      (await readFile(join("supabase/migrations", name), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    );
  for (const owner of [A, B]) {
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: owner, role: "authenticated" }),
    ]);
    await db.query("select public.ss_bootstrap()");
  }
  await db.exec("update public.user_usage set quota_bytes=1048576,max_slots=2");
}, 120000);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ss-lifecycle-"));
  // Exercise the runtime deadline: claim fsync and cold worker startup are part
  // of create(), not a one-second lifecycle contract. Vitest still bounds each
  // test; local-disk-transport.test.ts separately verifies deadline termination.
  disk = new LocalDiskTransport(root, 2);
  lifecycle = new VolumeLifecycle(database, disk, V);
  auth.id = A;
  await db.exec("begin");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec("rollback");
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

it("composes SQL admission, real disk, durable receipts, publication/list/download and client gzip restoration", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  expect(await usage()).toMatchObject({
    reserved_bytes: f.original.length + 131072,
    stored_bytes: 0,
    active_slots: 1,
  });
  await lifecycle.upload(
    A,
    s.id,
    0,
    source(f.encoded),
    new AbortController().signal,
  );
  const receipt = (await lifecycle.status(A, s.id)).objects[0].receiptId;
  expect(receipt).toBeTruthy();
  await lifecycle.publish(A, s.id);
  await lifecycle.publish(A, s.id);
  expect(await lifecycle.list(A)).toHaveLength(1);
  expect(await lifecycle.list(B)).toEqual([]);
  const manifest = (await lifecycle.status(A, s.id, "read")).manifest;
  const chunks: Uint8Array[] = [];
  let committed = false;
  await restore(
    manifest,
    {
      async open(block) {
        const d = await lifecycle.download(A, s.id, block.index);
        const iter = d.source[Symbol.asyncIterator]();
        return {
          index: block.index,
          stream: new ReadableStream<Uint8Array<ArrayBuffer>>({
            async pull(c) {
              const n = await iter.next();
              if (n.done) c.close();
              else c.enqueue(Uint8Array.from(n.value));
            },
          }),
        };
      },
    },
    {
      async write(b) {
        chunks.push(Uint8Array.from(b));
      },
      async commit() {
        committed = true;
      },
      async abort() {
        throw Error("UNEXPECTED_ABORT");
      },
    },
  );
  expect(committed).toBe(true);
  expect(Buffer.concat(chunks)).toEqual(f.original);
  expect(await usage()).toEqual({
    reserved_bytes: 0,
    active_slots: 0,
    stored_bytes:
      f.encoded.length + Buffer.byteLength(JSON.stringify(f.manifest)),
  });
  expect(
    (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.usage_events where kind='commit'",
      )
    ).rows[0].n,
  ).toBe(1);
  // Reader survives a new supervisor; unknown-writer cleanup does not.
  expect(
    (
      await new VolumeLifecycle(
        database,
        new LocalDiskTransport(root),
        V,
      ).download(A, s.id, 0)
    ).bytes,
  ).toBe(f.encoded.length);
});
it("denies foreign reads, claims, publication and cancellation plus all ordinary-user RPC access", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  for (const op of [
    () => lifecycle.status(B, s.id),
    () => lifecycle.publish(B, s.id),
    () => lifecycle.cancel(B, s.id),
    () =>
      lifecycle.upload(
        B,
        s.id,
        0,
        source(f.encoded),
        new AbortController().signal,
      ),
  ])
    await expect(op()).rejects.toThrow("NOT_FOUND");
  await db.exec("savepoint denied;set local role authenticated");
  await expect(database.command(A, "status", s.id)).rejects.toThrow(
    "permission denied",
  );
  await db.exec("rollback to savepoint denied");
  await expect(lifecycle.download(A, s.id, 0)).rejects.toThrow("NOT_FOUND");
});
it("retains failed-write liability, fences replay and safely settles same-supervisor removal once", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  await expect(
    lifecycle.upload(
      A,
      s.id,
      0,
      source(Buffer.alloc(f.encoded.length)),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(
    lifecycle.upload(
      A,
      s.id,
      0,
      source(f.encoded),
      new AbortController().signal,
    ),
  ).rejects.toThrow("ATTEMPT_AMBIGUOUS");
  await expect(lifecycle.publish(A, s.id)).rejects.toThrow(
    "FINALIZATION_BLOCKED",
  );
  expect((await usage()).reserved_bytes).toBe(f.original.length + 131072);
  await lifecycle.cancel(A, s.id);
  await lifecycle.cancel(A, s.id);
  expect(await usage()).toEqual({
    stored_bytes: 0,
    reserved_bytes: 0,
    active_slots: 0,
  });
  expect((await readdir(root)).every((n) => n.endsWith(".claim"))).toBe(true);
});
it("preserves liability after supervisor restart and prevents publication after cancel", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  await lifecycle.upload(
    A,
    s.id,
    0,
    source(f.encoded),
    new AbortController().signal,
  );
  await expect(
    new VolumeLifecycle(database, new LocalDiskTransport(root), V).cancel(
      A,
      s.id,
    ),
  ).rejects.toThrow("WRITER_TERMINATION_UNPROVEN");
  expect((await usage()).reserved_bytes).toBe(f.original.length + 131072);
  await expect(lifecycle.publish(A, s.id)).rejects.toThrow(
    "FINALIZATION_BLOCKED",
  );
  await lifecycle.cancel(A, s.id);
  expect((await usage()).reserved_bytes).toBe(0);
});
it("binds immutable manifests, blocks alternate attempt allocation and retains near-quota accounting", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  expect((await lifecycle.begin(A, f.input)).id).toBe(s.id);
  await expect(
    lifecycle.begin(A, {
      ...f.input,
      manifest: {
        ...f.manifest,
        blocks: [{ ...f.manifest.blocks[0], encodedSha256: "e".repeat(64) }],
      },
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await db.exec("savepoint alternate");
  await expect(
    db.query("select public.ss_allocate_attempt($1,0,$2,$3,'gzip',$4,$5)", [
      s.id,
      f.original.length,
      f.encoded.length,
      hash(f.original),
      hash(f.encoded),
    ]),
  ).rejects.toThrow("VOLUME_GATEWAY_REQUIRED");
  await db.exec("rollback to savepoint alternate");
  await db.query(
    "update public.user_usage set quota_bytes=reserved_bytes where owner_id=$1",
    [A],
  );
  await expect(
    lifecycle.begin(A, { ...f.input, key: "volume_upload_0002" }),
  ).rejects.toThrow("QUOTA_EXCEEDED");
  await lifecycle.cancel(A, s.id);
});
it.each([0, 1, 65537])(
  "round trips raw %i bytes including empty files",
  async (size) => {
    const f = fixture(Buffer.alloc(size, 17), false),
      s = await lifecycle.begin(A, f.input);
    await lifecycle.upload(
      A,
      s.id,
      0,
      source(f.encoded),
      new AbortController().signal,
    );
    await lifecycle.publish(A, s.id);
    const d = await lifecycle.download(A, s.id, 0),
      chunks = [];
    for await (const b of d.source) chunks.push(b);
    expect(Buffer.concat(chunks)).toEqual(f.original);
  },
);
it("retains stored quota until deletion proof, denies downloads after fencing, and deletes idempotently", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  await lifecycle.upload(
    A,
    s.id,
    0,
    source(f.encoded),
    new AbortController().signal,
  );
  await lifecycle.publish(A, s.id);
  const charged = (await usage()).stored_bytes;
  await database.command(A, "delete", s.id);
  expect((await usage()).stored_bytes).toBe(charged);
  await expect(lifecycle.download(A, s.id, 0)).rejects.toThrow("NOT_FOUND");
  await expect(database.command(A, "settle-delete", s.id)).rejects.toThrow(
    "CLEANUP_PROOF_REQUIRED",
  );
  await lifecycle.delete(A, s.id);
  await lifecycle.delete(A, s.id);
  expect(await usage()).toEqual({
    stored_bytes: 0,
    reserved_bytes: 0,
    active_slots: 0,
  });
  expect(
    (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.usage_events where kind='delete'",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("continues pending blocks after restart while preserving completed receipts and settles exactly once", async () => {
  const bytes = Buffer.alloc(65537, 19),
    chunks = [bytes.subarray(0, 65536), bytes.subarray(65536)];
  const manifest: Manifest = {
    format: "compression-spike",
    version: 1,
    blockSize: 65536,
    originalBytes: bytes.length,
    originalSha256: hash(bytes),
    blocks: chunks.map((b, index) => ({
      index,
      offset: index * 65536,
      originalBytes: b.length,
      encodedBytes: b.length,
      codec: "raw",
      originalSha256: hash(b),
      encodedSha256: hash(b),
    })),
  };
  const s = await lifecycle.begin(A, { ...fixture().input, manifest });
  await lifecycle.upload(
    A,
    s.id,
    0,
    source(chunks[0]),
    new AbortController().signal,
  );
  const receipt = (await lifecycle.status(A, s.id)).objects[0].receiptId;
  const restarted = new VolumeLifecycle(
    database,
    new LocalDiskTransport(root),
    V,
  );
  await restarted.upload(
    A,
    s.id,
    1,
    source(chunks[1]),
    new AbortController().signal,
  );
  await restarted.publish(A, s.id);
  expect((await restarted.status(A, s.id)).objects[0].receiptId).toBe(receipt);
  expect((await usage()).reserved_bytes).toBe(0);
});
it("retains stored quota while a download handle is open, then permits deletion after reader close", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  await lifecycle.upload(
    A,
    s.id,
    0,
    source(f.encoded),
    new AbortController().signal,
  );
  await lifecycle.publish(A, s.id);
  const charged = (await usage()).stored_bytes;
  const download = await new VolumeLifecycle(
      database,
      new LocalDiskTransport(root),
      V,
    ).download(A, s.id, 0),
    reader = download.source[Symbol.asyncIterator]();
  await reader.next();
  await expect(lifecycle.delete(A, s.id)).rejects.toThrow("READERS_ACTIVE");
  expect((await usage()).stored_bytes).toBe(charged);
  await reader.return?.();
  await lifecycle.delete(A, s.id);
  expect((await usage()).stored_bytes).toBe(0);
});
it("fences and terminates an interrupted writer before releasing its SQL reservation", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  let reached!: () => void;
  const partial = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const stream = (async function* () {
    yield f.encoded.subarray(0, 3);
    reached();
    await new Promise(() => {});
  })();
  const writing = lifecycle.upload(
    A,
    s.id,
    0,
    stream,
    new AbortController().signal,
  );
  const rejected = expect(writing).rejects.toThrow("ABORTED");
  await partial;
  expect((await usage()).reserved_bytes).toBe(f.original.length + 131072);
  await lifecycle.cancel(A, s.id);
  await rejected;
  expect(await usage()).toEqual({
    stored_bytes: 0,
    reserved_bytes: 0,
    active_slots: 0,
  });
});
it("aborts restoration on corrupted disk bytes without committing output or releasing stored quota", async () => {
  const f = fixture(),
    s = await lifecycle.begin(A, f.input);
  await lifecycle.upload(
    A,
    s.id,
    0,
    source(f.encoded),
    new AbortController().signal,
  );
  await lifecycle.publish(A, s.id);
  const charged = (await usage()).stored_bytes;
  const name = (await readdir(root)).find((n) => n.endsWith(".object"))!;
  await writeFile(join(root, name), Buffer.alloc(f.encoded.length));
  let committed = false,
    aborted = false;
  await expect(
    restore(
      f.manifest,
      {
        async open(block) {
          const d = await lifecycle.download(A, s.id, block.index),
            iter = d.source[Symbol.asyncIterator]();
          return {
            index: block.index,
            stream: new ReadableStream<Uint8Array<ArrayBuffer>>({
              async pull(c) {
                const n = await iter.next();
                if (n.done) c.close();
                else c.enqueue(Uint8Array.from(n.value));
              },
            }),
          };
        },
      },
      {
        async write() {},
        async commit() {
          committed = true;
        },
        async abort() {
          aborted = true;
        },
      },
    ),
  ).rejects.toThrow("ENCODED_INTEGRITY");
  expect(committed).toBe(false);
  expect(aborted).toBe(true);
  expect((await usage()).stored_bytes).toBe(charged);
});
it("runs preparation → authenticated HTTP upload → list → download → client restore and rejects unauthenticated/CSRF requests", async () => {
  for (const [key, value] of Object.entries({
    SMART_STORAGE_BACKEND_ENABLED: "true",
    SMART_STORAGE_TRANSFERS_ENABLED: "false",
    SMART_STORAGE_ENV: "development",
    APP_ORIGIN: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      "sb_publishable_local_test_placeholder",
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.method && init.method !== "GET")
      headers.set("origin", "http://localhost:3000");
    const req = new Request(new URL(path, "http://localhost:3000"), {
      ...init,
      headers,
    });
    const match = new URL(req.url).pathname.match(
      /^\/api\/volume-files\/([^/]+)\/blocks\/(\d+)$/,
    );
    return match
      ? volumeBlock(req, match[1], match[2])
      : req.method === "POST"
        ? volumePost(req)
        : volumeGet(req);
  });
  const checkpoints = new Map<string, Checkpoint>(),
    blocks = new Map<number, Blob>();
  const store: StagingStore = {
    async load(id) {
      return checkpoints.get(id)!;
    },
    async save(c, _expected, staged) {
      checkpoints.set(c.id, c);
      if (staged) blocks.set(staged.index, staged.blob);
    },
    async block(_id, index) {
      return blocks.get(index)!;
    },
  };
  const original = Buffer.from("client workflow exact bytes ".repeat(2000));
  const checkpoint = await prepare(
    new Blob([original]),
    store,
    undefined,
    undefined,
    undefined,
    { originalName: "source.txt", originalMime: "text/plain" },
  );
  let id = "";
  await uploadPreparedVolume(
    checkpoint,
    store,
    new AbortController().signal,
    (value) => {
      id = value;
    },
  );
  // Lost publication response is recoverable by checking durable server state.
  await uploadPreparedVolume(
    checkpoint,
    store,
    new AbortController().signal,
    () => {},
  );
  const listing = await (await fetch("/api/volume-files")).json();
  expect(listing.files).toHaveLength(1);
  let committed = false,
    aborted = false;
  const chunks: Uint8Array[] = [];
  await restoreVolume(
    id,
    {
      async write(b) {
        chunks.push(Uint8Array.from(b));
      },
      async commit() {
        committed = true;
      },
      async abort() {
        aborted = true;
      },
    },
    new AbortController().signal,
  );
  expect(committed).toBe(true);
  expect(aborted).toBe(false);
  expect(Buffer.concat(chunks)).toEqual(original);
  auth.id = B;
  expect((await fetch(`/api/volume-files/${id}/blocks/0`)).status).toBe(404);
  auth.id = null;
  expect((await fetch("/api/volume-files")).status).toBe(401);
  auth.id = A;
  const denied = await volumePost(
    new Request("http://localhost:3000/api/volume-files", {
      method: "POST",
      headers: {
        origin: "https://foreign.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "cancel", id }),
    }),
  );
  expect(denied.status).toBe(403);
});
