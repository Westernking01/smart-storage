import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { SupabaseStorageProvider } from "../../src/lib/gateway/supabase-storage-provider.server";
import {
  retainProviderHolds,
  type DispatchPermit,
  type DurableEvidenceSink,
  type ProvisionalObservation,
  type StorageTransport,
  type TransportResponse,
  type WriteIntent,
} from "../../src/lib/gateway/provider-contracts";

const data = new Uint8Array([1, 2, 3]);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const intent: WriteIntent = {
  ownerId: "owner",
  sessionId: "session",
  fileId: "file",
  attemptId: "attempt",
  requestId: "request",
  resourceId: "resource",
  executorId: "executor",
  epoch: 1,
  dispatchGeneration: 1,
  bucket: "private",
  path: "immutable/key",
  declaredBytes: 3,
  expectedSha256: sha(data),
  operation: "single-object-create",
};
const source = async function* (bytes = data) {
  yield bytes;
};
const response: TransportResponse = {
  kind: "response",
  status: 200,
  provenance: "authenticated-storage-response",
  requestId: "provider-request",
  version: null,
  etag: null,
  acknowledgedBytes: 3,
};
function fixture(overrides: Partial<DispatchPermit> = {}) {
  // Disposable durable-authority model only; this does not implement SQL authority.
  let consumed = false;
  const records: ProvisionalObservation[] = [];
  const authority = {
    consumeDispatch: vi.fn(async (value: WriteIntent) => {
      if (consumed) return null;
      consumed = true;
      return {
        intent: value,
        decisionId: "decision",
        writerId: "writer",
        reservationId: "reservation",
        exposureId: "exposure",
        maximumEncodedBytes: 3,
        reservedExposureBytes: 3,
        allowZeroBytes: false,
        ...overrides,
      };
    }),
  };
  const create = vi.fn<StorageTransport["create"]>(async ({ body }) => {
    for await (const chunk of body) {
      void chunk;
    }
    return response;
  });
  const transport: StorageTransport = {
    assertSupported: (op) => {
      if (op !== "single-object-create") throw Error("unsupported");
    },
    create,
  };
  const append = vi.fn<DurableEvidenceSink["append"]>(async (record) => {
    records.push(record);
    return { receiptId: `receipt-${records.length}` };
  });
  const adapter = new SupabaseStorageProvider(
    transport,
    authority,
    { append },
    { timeoutMs: 100, maximumChunkBytes: 16 },
    () => 123,
  );
  return { adapter, create, append, records, authority, transport };
}
afterEach(() => vi.useRealTimers());
describe("local single-object server adapter", () => {
  it("uses null dispatch digest and preserves verified content digest", async () => {
    const f = fixture();
    const result = await f.adapter.write(intent, source());
    expect(f.records[0]).toMatchObject({
      state: "dispatch-intent",
      sha256: null,
      digestComplete: false,
      forwardedBytes: 0,
    });
    expect(result.observation).toMatchObject({
      state: "response-observed",
      sha256: sha(data),
      digestComplete: true,
    });
  });
  it("bounds each chunk and applies pull backpressure", async () => {
    const f = fixture();
    let pulled = 0;
    const input = (async function* () {
      for (const byte of data) {
        pulled++;
        yield Uint8Array.of(byte);
      }
    })();
    f.create.mockImplementation(async ({ body }) => {
      expect(pulled).toBe(0);
      const iterator = body[Symbol.asyncIterator]();
      await iterator.next();
      expect(pulled).toBe(1);
      await iterator.next();
      await iterator.next();
      await iterator.next();
      return response;
    });
    expect((await f.adapter.write(intent, input)).observation.state).toBe(
      "response-observed",
    );
    const large = fixture({
      maximumEncodedBytes: 17,
      reservedExposureBytes: 17,
    });
    const result = await large.adapter.write(
      { ...intent, declaredBytes: 17 },
      source(new Uint8Array(17)),
    );
    expect(result.observation).toMatchObject({
      reason: "CHUNK_TOO_LARGE",
      forwardedBytes: 0,
    });
  });
  it("keeps concurrent duplicates blocked while first writer is pending", async () => {
    const f = fixture();
    const first = f.adapter.write(intent, source());
    await expect(f.adapter.write(intent, source())).rejects.toThrow(
      "INVALID_GRANT",
    );
    await first;
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("records source failure and closes source on overflow", async () => {
    const f = fixture();
    let closed = false;
    const input = (async function* () {
      try {
        yield new Uint8Array(4);
      } finally {
        closed = true;
      }
    })();
    expect((await f.adapter.write(intent, input)).observation.reason).toBe(
      "OVERSIZED",
    );
    expect(closed).toBe(true);
    const broken = fixture();
    const badInput = (async function* () {
      yield Uint8Array.of(1);
      throw Error("private");
    })();
    expect(
      (await broken.adapter.write(intent, badInput)).observation.reason,
    ).toBe("INPUT_FAILURE");
  });
  it("rejects unbounded or malformed provider metadata", async () => {
    const f = fixture();
    f.create.mockImplementation(async ({ body }) => {
      for await (const chunk of body) {
        void chunk;
      }
      return { ...response, etag: "x".repeat(1025) };
    });
    expect((await f.adapter.write(intent, source())).observation).toMatchObject(
      { reason: "UNVERIFIED_RESPONSE", response: null },
    );
  });
  it.each([
    { intent: { ...intent, epoch: 2 } },
    { intent: { ...intent, path: "other" } },
    { intent: { ...intent, ownerId: "other" } },
    { intent: { ...intent, attemptId: "other" } },
    { intent: { ...intent, dispatchGeneration: 2 } },
    { writerId: "" },
    { reservationId: "" },
    { exposureId: "" },
    { decisionId: "" },
    { maximumEncodedBytes: 2 },
    { reservedExposureBytes: 2 },
  ])(
    "rejects invalid durable grant with zero transport calls %j",
    async (grant) => {
      const f = fixture(grant);
      await expect(f.adapter.write(intent, source())).rejects.toThrow(
        "INVALID_GRANT",
      );
      expect(f.create).not.toHaveBeenCalled();
    },
  );
  it("accepts exact bytes as persisted provisional evidence only", async () => {
    const f = fixture();
    const result = await f.adapter.write(intent, source());
    expect(result.evidencePersistence).toBe("durable-acknowledged");
    expect(result.observation).toMatchObject({
      state: "response-observed",
      inputBytes: 3,
      forwardedBytes: 3,
      sha256: sha(data),
      certified: false,
      retainHolds: true,
      futureProviderEffectsPossible: true,
    });
    expect(f.records[0].state).toBe("dispatch-intent");
    expect(f.create.mock.calls[0][0].options).toEqual({
      redirect: "error",
      retries: 0,
      upsert: false,
      contentType: "application/octet-stream",
      contentLength: 3,
    });
  });
  it("rejects zero unless explicitly permitted", async () => {
    const empty = {
      ...intent,
      declaredBytes: 0,
      expectedSha256: sha(new Uint8Array()),
    };
    const denied = fixture();
    await expect(
      denied.adapter.write(empty, source(new Uint8Array())),
    ).rejects.toThrow("INVALID_GRANT");
    expect(denied.create).not.toHaveBeenCalled();
    const allowed = fixture({ allowZeroBytes: true });
    allowed.create.mockImplementation(async ({ body }) => {
      for await (const chunk of body) {
        void chunk;
      }
      return { ...response, acknowledgedBytes: 0 };
    });
    expect(
      (await allowed.adapter.write(empty, source(new Uint8Array()))).observation
        .state,
    ).toBe("response-observed");
  });
  it.each([
    [new Uint8Array([1]), "TRUNCATED"],
    [new Uint8Array(4), "OVERSIZED"],
    [new Uint8Array([3, 2, 1]), "HASH_MISMATCH"],
  ])("retains holds on stream fault %s", async (bytes, reason) => {
    const f = fixture();
    const result = await f.adapter.write(intent, source(bytes));
    expect(result.observation).toMatchObject({
      state: "ambiguous",
      reason,
      retainHolds: true,
    });
  });
  it("rejects wrong declared size before transport", async () => {
    const f = fixture();
    await expect(
      f.adapter.write({ ...intent, declaredBytes: 4 }, source()),
    ).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("blocks duplicate invocation across adapter instances via authority", async () => {
    const f = fixture();
    await f.adapter.write(intent, source());
    const other = new SupabaseStorageProvider(f.transport, f.authority, {
      append: f.append,
    });
    await expect(other.write(intent, source())).rejects.toThrow(
      "INVALID_GRANT",
    );
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("records lost response/transport rejection as ambiguous without retry", async () => {
    const f = fixture();
    f.create.mockImplementation(async ({ body }) => {
      for await (const chunk of body) {
        void chunk;
      }
      throw Error("lost response with sensitive text");
    });
    const result = await f.adapter.write(intent, source());
    expect(result.observation).toMatchObject({
      state: "ambiguous",
      reason: "TRANSPORT_FAILURE",
      retainHolds: true,
    });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("times out while delayed provider commit remains possible", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let commit = false;
    f.create.mockImplementation(async ({ body }) => {
      for await (const chunk of body) {
        void chunk;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      commit = true;
      return response;
    });
    const pending = f.adapter.write(intent, source());
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.observation).toMatchObject({
      state: "ambiguous",
      reason: "TIMEOUT",
      futureProviderEffectsPossible: true,
    });
    expect(commit).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(commit).toBe(true);
    expect(result.observation.state).toBe("ambiguous");
  });
  it("blocks transport on initial evidence failure", async () => {
    const f = fixture();
    f.append.mockRejectedValue(Error("disk"));
    await expect(f.adapter.write(intent, source())).rejects.toThrow(
      "EVIDENCE_FAILURE",
    );
    expect(f.create).not.toHaveBeenCalled();
  });
  it("does not certify when final evidence persistence fails", async () => {
    const f = fixture();
    f.append
      .mockResolvedValueOnce({ receiptId: "start" })
      .mockRejectedValueOnce(Error("disk"));
    const result = await f.adapter.write(intent, source());
    expect(result.evidencePersistence).toBe("failed-or-unknown");
    expect(result.observation.certified).toBe(false);
    await expect(f.adapter.write(intent, source())).rejects.toThrow(
      "INVALID_GRANT",
    );
  });
  it.each([
    { visibility: "absent", discovery: "complete" }, // may be masked 404
    { visibility: "unknown", discovery: "incomplete" },
    { visibility: "present", discovery: "unknown" },
  ] as const)("never treats hints as authoritative %j", (hint) => {
    expect(retainProviderHolds(hint)).toEqual({
      retainHolds: true,
      certified: false,
    });
  });
  it("rejects redirects and provider size mismatch", async () => {
    for (const reply of [
      { ...response, status: 302 },
      { ...response, acknowledgedBytes: 2 },
    ]) {
      const f = fixture();
      f.create.mockImplementation(async ({ body }) => {
        for await (const chunk of body) {
          void chunk;
        }
        return reply;
      });
      expect((await f.adapter.write(intent, source())).observation.state).toBe(
        "ambiguous",
      );
    }
  });
  it("rejects transport success without exhausting input", async () => {
    const f = fixture();
    f.create.mockResolvedValue(response);
    expect((await f.adapter.write(intent, source())).observation.reason).toBe(
      "INPUT_NOT_EXHAUSTED",
    );
  });
  it("rejects unsupported capabilities without authority or transport", async () => {
    const f = fixture();
    await expect(
      f.adapter.write(
        { ...intent, operation: "tus" } as unknown as WriteIntent,
        source(),
      ),
    ).rejects.toThrow("UNSUPPORTED_CAPABILITY");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.authority.consumeDispatch).not.toHaveBeenCalled();
  });
});
