import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  SupabaseStorageTransport,
  type HttpFetch,
  type TransportDependencies,
  type TransportHint,
} from "../../src/lib/gateway/supabase-storage-transport.server";
import { SupabaseStorageProvider } from "../../src/lib/gateway/supabase-storage-provider.server";
import { createConcretePostgresStorageProvider } from "../../src/lib/gateway/postgres-provider.server";
import type {
  DispatchPermit,
  ProvisionalObservation,
  StorageTransport,
  WriteIntent,
} from "../../src/lib/gateway/provider-contracts";

const bytes = new Uint8Array([1, 2, 3]);
const sha = createHash("sha256").update(bytes).digest("hex");
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
  path: "test/key",
  declaredBytes: 3,
  expectedSha256: sha,
  operation: "single-object-create",
};
const source = async function* (data = bytes) {
  yield data;
};
async function drain(init: RequestInit) {
  const reader = (init.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}
function fixture(
  overrides: Partial<TransportDependencies> = {},
  http?: HttpFetch,
) {
  const hints: TransportHint[] = [];
  const fetch = vi.fn<HttpFetch>(
    http ??
      (async (_url, init) => {
        await drain(init);
        return new Response(null, {
          status: 200,
          headers: {
            "x-request-id": "request",
            etag: "opaque-etag",
            "x-version-id": "v1",
          },
        });
      }),
  );
  const credentials = vi.fn(async () => ({
    bearer: "synthetic-bearer",
    apiKey: "synthetic-key",
  }));
  const dependencies: TransportDependencies = {
    endpoint: "https://storage.invalid/storage/v1",
    bucket: "private",
    prefix: "test",
    maximumEncodedBytes: 3,
    timeoutMs: 100,
    enabled: true,
    credentials,
    fetch,
    report: async (hint) => {
      hints.push(hint);
    },
    exposureBound: () => 3,
    ...overrides,
  };
  const transport = new SupabaseStorageTransport(dependencies);
  const permit: DispatchPermit = {
    intent,
    decisionId: "request",
    writerId: "executor",
    reservationId: "session",
    exposureId: "resource",
    maximumEncodedBytes: 3,
    reservedExposureBytes: 3,
    allowZeroBytes: false,
  };
  const controller = new AbortController();
  const input: Parameters<StorageTransport["create"]>[0] = {
    intent,
    permit,
    body: source(),
    signal: controller.signal,
    options: {
      redirect: "error",
      retries: 0,
      upsert: false,
      contentType: "application/octet-stream",
      contentLength: 3,
    },
  };
  return {
    transport,
    fetch,
    hints,
    input,
    controller,
    credentials,
    dependencies,
  };
}
afterEach(() => vi.useRealTimers());
describe("concrete mocked Storage HTTP boundary", () => {
  it("composes real bindings over mocked SQL/HTTP, commits authority before HTTP and persists ambiguity", async () => {
    let inTransaction = false;
    const f = fixture({}, async (_url, init) => {
      expect(inTransaction).toBe(false);
      await drain(init);
      return new Response();
    });
    const observations: ProvisionalObservation[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === "BEGIN") inTransaction = true;
      if (sql === "COMMIT" || sql === "ROLLBACK") inTransaction = false;
      if (sql.includes("AS allowed")) return { rows: [{ allowed: true }] };
      if (sql.includes("AS permit"))
        return { rows: [{ permit: f.input.permit }] };
      if (sql.includes("AS receipt")) {
        observations.push(JSON.parse(values?.[6] as string));
        return { rows: [{ receipt: "00000000-0000-4000-8000-000000000008" }] };
      }
      return { rows: [] };
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) };
    const identity = async () => ({
      ownerId: intent.ownerId,
      executorId: intent.executorId,
    });
    const disabled = createConcretePostgresStorageProvider(pool, identity, {
      ...f.dependencies,
      enabled: undefined,
    });
    await expect(disabled.provider.write(intent, source())).rejects.toThrow(
      "TRANSPORT_DISABLED",
    );
    expect(pool.connect).not.toHaveBeenCalled();
    const active = createConcretePostgresStorageProvider(
      pool,
      identity,
      f.dependencies,
    );
    expect(
      (await active.provider.write(intent, source())).observation,
    ).toMatchObject({ state: "ambiguous", retainHolds: true });
    expect(observations.map((o) => o.state)).toEqual([
      "dispatch-intent",
      "ambiguous",
    ]);
    expect(pool.connect).toHaveBeenCalledTimes(3);
  });
  it("extracts bounded provider object IDs and error codes from JSON", async () => {
    const f = fixture({}, async (_u, init) => {
      await drain(init);
      return Response.json(
        { Id: "provider-id", code: "KeyAlreadyExists" },
        { status: 409 },
      );
    });
    await f.transport.create(f.input);
    expect(f.hints.at(-1)).toMatchObject({
      objectId: "provider-id",
      errorCode: "KeyAlreadyExists",
      dispatchRequestId: intent.requestId,
      resourceId: intent.resourceId,
    });
  });
  it("bounds inspection waits even if HTTP ignores abort", async () => {
    vi.useFakeTimers();
    const f = fixture({}, async () => new Promise(() => {}));
    const pending = expect(
      f.transport.inspect(intent, "metadata", f.controller.signal),
    ).rejects.toThrow("INSPECTION_UNKNOWN");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
  });
  it("bounds independent reads and JSON inspection buffers", async () => {
    for (const kind of ["metadata", "hash", "list"] as const) {
      const f = fixture({}, async () => new Response(new Uint8Array(65537)));
      await expect(
        f.transport.inspect(intent, kind, f.controller.signal),
      ).rejects.toThrow("INSPECTION_LIMIT");
    }
  });
  it("suppresses dispatch on pre-aborted input", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.transport.create(f.input)).rejects.toThrow(
      "CANCELLED_UNKNOWN",
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not claim delivery when HTTP returns before consuming input", async () => {
    const f = fixture({}, async () => new Response());
    await expect(f.transport.create(f.input)).rejects.toThrow(
      "INPUT_NOT_EXHAUSTED",
    );
    expect(f.hints.at(-1)).toMatchObject({
      state: "unknown",
      forwardedBytes: 0,
      retainHolds: true,
    });
  });
  it("streams a create-only exact-limit request and captures provisional identity without inventing acknowledged bytes", async () => {
    const f = fixture();
    expect(await f.transport.create(f.input)).toMatchObject({
      status: 200,
      acknowledgedBytes: null,
      version: "v1",
      etag: "opaque-etag",
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]).toEqual([
      "https://storage.invalid/storage/v1/object/private/test/key",
      expect.objectContaining({
        method: "POST",
        duplex: "half",
        redirect: "error",
        headers: expect.objectContaining({
          "x-upsert": "false",
          "Content-Length": "3",
        }),
      }),
    ]);
    expect(f.hints.at(-1)).toMatchObject({
      state: "response",
      forwardedBytes: 3,
      certified: false,
      retainHolds: true,
    });
  });
  it.each([400, 409, 429, 500])(
    "records rejected %i once without retry",
    async (status) => {
      const f = fixture({}, async (_u, init) => {
        await drain(init);
        return new Response(null, {
          status,
          headers: { "x-error-code": "KeyAlreadyExists" },
        });
      });
      expect((await f.transport.create(f.input)).status).toBe(status);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.hints.at(-1)).toMatchObject({
        errorCode: "KeyAlreadyExists",
        reason: "REJECTED_PROVISIONAL",
      });
    },
  );
  it("rejects upsert and mismatched Content-Length before HTTP", async () => {
    const f = fixture();
    await expect(
      f.transport.create({
        ...f.input,
        options: { ...f.input.options, upsert: true } as never,
      }),
    ).rejects.toThrow("UNSUPPORTED_OPTIONS");
    await expect(
      f.transport.create({
        ...f.input,
        options: { ...f.input.options, contentLength: 4 },
      }),
    ).rejects.toThrow("UNSUPPORTED_OPTIONS");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects redirects without follow-up", async () => {
    const f = fixture(
      {},
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://other.invalid" },
        }),
    );
    await expect(f.transport.create(f.input)).rejects.toThrow(
      "REDIRECT_REJECTED",
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [new Uint8Array([1, 2, 3, 4]), "OVERSIZED", 0],
    [new Uint8Array([1]), "TRUNCATED", 1],
    [new Uint8Array([3, 2, 1]), "HASH_MISMATCH", 3],
  ] as const)(
    "rejects invalid stream %s",
    async (data, reason, forwardedBytes) => {
      const f = fixture();
      await expect(
        f.transport.create({ ...f.input, body: source(data) }),
      ).rejects.toThrow(reason);
      expect(f.hints.at(-1)).toMatchObject({
        state: "unknown",
        forwardedBytes,
        retainHolds: true,
      });
    },
  );
  it("fails closed on disabled or unqualified exposure before secrets or HTTP", async () => {
    for (const options of [
      { enabled: false },
      { exposureBound: () => null },
      { exposureBound: () => 4 },
    ]) {
      const f = fixture(options);
      await expect(f.transport.create(f.input)).rejects.toThrow();
      expect(f.credentials).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it("binds immutable registered bucket/key and permit", async () => {
    for (const changes of [
      { path: "elsewhere/key" },
      { path: "test/../key" },
      { bucket: "other" },
      { epoch: 2 },
    ]) {
      const f = fixture();
      await expect(
        f.transport.create({ ...f.input, intent: { ...intent, ...changes } }),
      ).rejects.toThrow();
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it("times out an uncooperative writer without retry", async () => {
    vi.useFakeTimers();
    const f = fixture({}, async () => new Promise(() => {}));
    const pending = expect(f.transport.create(f.input)).rejects.toThrow(
      "TIMEOUT_UNKNOWN",
    );
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("retains uncertainty after abort even when provider later commits", async () => {
    let commit!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let committed = false;
    const f = fixture({}, async (_u, init) => {
      await drain(init);
      entered();
      await new Promise<void>((resolve) => {
        commit = resolve;
      });
      committed = true;
      return new Response();
    });
    const result = f.transport.create(f.input);
    const assertion = expect(result).rejects.toThrow("CANCELLED_UNKNOWN");
    await barrier;
    f.controller.abort();
    await assertion;
    expect(f.hints.at(-1)).toMatchObject({
      futureProviderEffectsPossible: true,
      retainHolds: true,
    });
    commit();
    await Promise.resolve();
    expect(committed).toBe(true);
  });
  it("does not replay after a lost response", async () => {
    const f = fixture({}, async (_u, init) => {
      await drain(init);
      throw Error("socket lost after commit");
    });
    await expect(f.transport.create(f.input)).rejects.toThrow("LOST_RESPONSE");
    await expect(f.transport.create(f.input)).rejects.toThrow(
      "DUPLICATE_DISPATCH",
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("waits for delayed completion without eager buffering", async () => {
    let finish!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const produced = vi.fn();
    const f = fixture({}, async (_u, init) => {
      expect(produced).not.toHaveBeenCalled();
      await drain(init);
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return new Response();
    });
    const pending = f.transport.create({
      ...f.input,
      body: (async function* () {
        produced();
        yield bytes;
      })(),
    });
    await ready;
    expect(f.hints).toHaveLength(1);
    finish();
    expect((await pending).status).toBe(200);
  });
  it("does not dispatch when provisional intent persistence fails", async () => {
    const f = fixture({
      report: async () => {
        throw Error("evidence unavailable");
      },
    });
    await expect(f.transport.create(f.input)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("retains SQL-adapter holds and durable ambiguity on success without byte acknowledgment", async () => {
    const f = fixture();
    let consumed = false;
    const records: ProvisionalObservation[] = [];
    const adapter = new SupabaseStorageProvider(
      f.transport,
      {
        consumeDispatch: async () => {
          if (consumed) return null;
          consumed = true;
          return f.input.permit;
        },
      },
      {
        append: async (observation) => {
          records.push(observation);
          return { receiptId: "receipt" };
        },
      },
    );
    const result = await adapter.write(intent, source());
    expect(result.observation).toMatchObject({
      state: "ambiguous",
      retainHolds: true,
      certified: false,
      response: { status: 200, acknowledgedBytes: null },
    });
    await expect(adapter.write(intent, source())).rejects.toThrow(
      "INVALID_GRANT",
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(2);
  });
  it("reports final evidence failure without releasing reservations", async () => {
    const f = fixture();
    let calls = 0;
    const adapter = new SupabaseStorageProvider(
      f.transport,
      { consumeDispatch: async () => f.input.permit },
      {
        append: async () => {
          if (++calls === 2) throw Error("lost commit");
          return { receiptId: "receipt" };
        },
      },
    );
    const result = await adapter.write(intent, source());
    expect(result.evidencePersistence).toBe("failed-or-unknown");
    expect(result.observation.retainHolds).toBe(true);
  });
  it("returns metadata mismatches as untrusted hints", async () => {
    const f = fixture({}, async () => Response.json({ size: 99 }));
    expect(
      await f.transport.inspect(intent, "metadata", f.controller.signal),
    ).toMatchObject({ metadataLengthMatches: false, certified: false });
  });
  it("hashes independently read bytes and detects a mismatch", async () => {
    for (const data of [bytes, new Uint8Array([9])]) {
      const f = fixture({}, async () => new Response(data));
      expect(
        await f.transport.inspect(intent, "hash", f.controller.signal),
      ).toMatchObject({
        matches: data === bytes,
        bytes: data.length,
        retainHolds: true,
      });
    }
  });
  it("never claims complete enumeration from one bounded page", async () => {
    const f = fixture({}, async () => Response.json([{ name: "key" }]));
    expect(
      await f.transport.inspect(intent, "list", f.controller.signal),
    ).toMatchObject({ discovery: "incomplete", certified: false });
    expect(f.transport.temporaryResources()).toMatchObject({
      supported: false,
      discovery: "unknown",
    });
  });
  it("treats masked absence as unknown", async () => {
    const f = fixture({}, async () => new Response(null, { status: 404 }));
    expect(
      await f.transport.inspect(intent, "metadata", f.controller.signal),
    ).toMatchObject({ visibility: "unknown", retainHolds: true });
  });
  it("requires explicit scoped deletion authorization and retains possible writers after reinspection", async () => {
    const f = fixture(
      {},
      async (_u, init) =>
        new Response(null, { status: init.method === "DELETE" ? 200 : 404 }),
    );
    await expect(
      f.transport.deleteForTest(intent, async () => false, f.controller.signal),
    ).rejects.toThrow("TEST_DELETE_UNAUTHORIZED");
    expect(f.fetch).not.toHaveBeenCalled();
    const result = await f.transport.deleteForTest(
      intent,
      async (scope) => scope.path === intent.path,
      f.controller.signal,
    );
    expect(result).toMatchObject({
      deletionStatus: 200,
      after: { visibility: "unknown" },
      futureProviderEffectsPossible: true,
      retainHolds: true,
      certified: false,
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});
