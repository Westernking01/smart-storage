import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { LocalDiskTransport } from "../../src/lib/gateway/local-disk-transport.server";
import { SupabaseStorageProvider } from "../../src/lib/gateway/supabase-storage-provider.server";
import type {
  WriteIntent,
  DispatchPermit,
  StorageTransport,
} from "../../src/lib/gateway/provider-contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(deadline = 2000) {
  const root = await mkdtemp(join(tmpdir(), "ss-bounded-disk-"));
  roots.push(root);
  const bytes = Buffer.from("encoded");
  const intent: WriteIntent = {
    ownerId: "a",
    sessionId: "s",
    fileId: "f",
    attemptId: "t",
    requestId: "q",
    resourceId: "r",
    executorId: "e",
    epoch: 1,
    dispatchGeneration: 1,
    bucket: "private",
    path: "opaque",
    declaredBytes: bytes.length,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    operation: "single-object-create",
  };
  const permit: DispatchPermit = {
    intent,
    decisionId: "q",
    writerId: "e",
    reservationId: "s",
    exposureId: "r",
    maximumEncodedBytes: bytes.length,
    reservedExposureBytes: bytes.length,
    allowZeroBytes: false,
  };
  const transport = new LocalDiskTransport(root, 1, deadline);
  const source = async function* () {
    yield bytes;
  };
  const input: Parameters<StorageTransport["create"]>[0] = {
    intent,
    permit,
    body: source(),
    signal: new AbortController().signal,
    options: {
      redirect: "error",
      retries: 0,
      upsert: false,
      contentType: "application/octet-stream",
      contentLength: bytes.length,
    },
  };
  return { root, bytes, intent, permit, transport, input };
}
it("writes real bytes once, checks hash, terminates before removal and fences replay after restart", async () => {
  const f = await fixture();
  expect((await f.transport.create(f.input)).acknowledgedBytes).toBe(
    f.bytes.length,
  );
  const object = (await readdir(f.root)).find((n) => n.endsWith(".object"))!;
  expect(await readFile(join(f.root, object))).toEqual(f.bytes);
  expect(await f.transport.terminateAndRemove(f.intent)).toMatchObject({
    writerTerminated: true,
    objectAbsent: true,
    retainDatabaseHolds: true,
  });
  expect(await readdir(f.root)).toHaveLength(1);
  await expect(
    new LocalDiskTransport(f.root).create(f.input),
  ).rejects.toThrow();
  await expect(
    new LocalDiskTransport(f.root).terminateAndRemove(f.intent),
  ).rejects.toThrow("WRITER_TERMINATION_UNPROVEN");
});
it.each(["oversized", "truncated", "hash"])(
  "retains claim and bounds actual disk exposure on %s input",
  async (mode) => {
    const f = await fixture();
    f.input.body = (async function* () {
      yield mode === "oversized"
        ? Buffer.alloc(8)
        : mode === "truncated"
          ? Buffer.alloc(2)
          : Buffer.alloc(7);
    })();
    await expect(f.transport.create(f.input)).rejects.toThrow();
    const object = (await readdir(f.root)).find((n) => n.endsWith(".object"))!;
    expect((await readFile(join(f.root, object))).length).toBeLessThanOrEqual(
      mode === "oversized" ? 0 : 7,
    );
    await f.transport.terminateAndRemove(f.intent);
  },
);
it("kills a real writer on deadline even when source.next never settles", async () => {
  const f = await fixture(200);
  f.input.body = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  await expect(f.transport.create(f.input)).rejects.toThrow("ABORTED");
  await f.transport.terminateAndRemove(f.intent);
  expect((await readdir(f.root)).every((n) => n.endsWith(".claim"))).toBe(true);
});
it("fences startup cancellation and denies cleanup from an unrelated supervisor", async () => {
  const f = await fixture();
  const result = f.transport.create(f.input);
  const failed = expect(result).rejects.toThrow("ABORTED");
  await f.transport.terminateAndRemove(f.intent);
  await failed;
  await expect(
    new LocalDiskTransport(f.root).terminateAndRemove(f.intent),
  ).rejects.toThrow("WRITER_TERMINATION_UNPROVEN");
});
it("serializes independent adapter claims and refuses permit/owner bypass", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.transport.create(f.input),
    new LocalDiskTransport(f.root).create(f.input),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await expect(
    new LocalDiskTransport(f.root).create({
      ...f.input,
      intent: { ...f.intent, ownerId: "foreign" },
    }),
  ).rejects.toThrow("INVALID_GRANT");
});
it("composes with consumed dispatch and provisional evidence without releasing liability", async () => {
  const f = await fixture();
  let consumed = false;
  const evidence: unknown[] = [];
  const provider = new SupabaseStorageProvider(
    f.transport,
    {
      consumeDispatch: async () => {
        if (consumed) throw Error("REPLAY_DENIED");
        consumed = true;
        return f.permit;
      },
    },
    {
      append: async (observation) => {
        evidence.push(observation);
        return { receiptId: String(evidence.length) };
      },
    },
  );
  const result = await provider.write(f.intent, f.input.body);
  expect(result.observation.state).toBe("response-observed");
  expect(result.observation.retainHolds).toBe(true);
  expect(result.observation.certified).toBe(false);
  await expect(provider.write(f.intent, f.input.body)).rejects.toThrow(
    "REPLAY_DENIED",
  );
  expect(evidence).toHaveLength(2);
  await f.transport.terminateAndRemove(f.intent);
});

it("cancels an interrupted real partial write, bounds active writers, and denies forged cleanup", async () => {
  const f = await fixture();
  let reached!: () => void;
  const partialWritten = new Promise<void>((r) => {
    reached = r;
  });
  f.input.body = (async function* () {
    yield f.bytes.subarray(0, 3);
    // next() resumes only after the first disk acknowledgement.
    reached();
    await new Promise(() => {});
  })();
  const writing = f.transport.create(f.input);
  const rejected = expect(writing).rejects.toThrow("ABORTED");
  await partialWritten;
  await expect(
    f.transport.terminateAndRemove({ ...f.intent, ownerId: "foreign" }),
  ).rejects.toThrow("WRITER_TERMINATION_UNPROVEN");
  await expect(
    f.transport.create({
      ...f.input,
      intent: { ...f.intent, path: "another" },
      permit: { ...f.permit, intent: { ...f.intent, path: "another" } },
    }),
  ).rejects.toThrow("WRITER_CAPACITY");
  expect(await f.transport.terminateAndRemove(f.intent)).toMatchObject({
    objectAbsent: true,
  });
  await rejected;
  expect((await readdir(f.root)).every((n) => n.endsWith(".claim"))).toBe(true);
});
