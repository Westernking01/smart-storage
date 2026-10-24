import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  ReadOnlyInspectionRunner,
  type ProbeTarget,
} from "../../src/lib/gateway/inspection-runner.server";
import {
  PostgresInspectionEvidence,
  type InspectionObservation,
} from "../../src/lib/gateway/inspection-evidence.server";
const id = "00000000-0000-4000-8000-000000000001";
const target: ProbeTarget = {
  project: "abcdefghijklmnopqrst",
  endpoint: "https://abcdefghijklmnopqrst.supabase.co/storage/v1",
  prefix: "probe",
  scope: { namespace: "test", uploadId: null, version: null, generation: null },
  intent: {
    ownerId: id,
    executorId: id,
    requestId: id,
    resourceId: id,
    sessionId: id,
    fileId: id,
    attemptId: id,
    epoch: 1,
    dispatchGeneration: 1,
    bucket: "private",
    path: "probe/key",
    declaredBytes: 3,
    expectedSha256: createHash("sha256").update("abc").digest("hex"),
    operation: "single-object-create",
  },
};
function fixture(
  response: () => Promise<Response> = async () => new Response("abc"),
  options: Record<string, unknown> = {},
) {
  const observations: InspectionObservation[] = [];
  const append = vi.fn(async (v: InspectionObservation) => {
    observations.push(v);
  });
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    void _url;
    void _init;
    return response();
  });
  const credentials = vi.fn(async () => ({ bearer: "test", apiKey: "test" }));
  const runner = new ReadOnlyInspectionRunner({
    enabled: true,
    target,
    authorization: {
      target,
      authorizationId: "approved-fixture",
      expiresAt: Date.now() + 60000,
      readOnly: true,
      accounting: "accepted-raw-response-body",
    },
    fetch,
    credentials,
    sink: { append },
    fence: { claim: async () => {} },
    ...options,
  });
  return { runner, observations, append, fetch, credentials };
}
const run = (
  f: ReturnType<typeof fixture>,
  kind: "hash" | "metadata" | "list" = "hash",
) => f.runner.run(kind, id, new AbortController().signal);
describe("durable read-only inspections", () => {
  it.each([false, undefined])("disabled by default (%s)", async (enabled) => {
    const f = fixture(undefined, { enabled });
    await expect(run(f)).rejects.toThrow("PROBE_DISABLED");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.credentials).not.toHaveBeenCalled();
  });
  it.each([
    { target: undefined },
    ...[undefined, "physical-network-bytes"].map((accounting) => ({
      authorization: {
        target,
        authorizationId: "wrong-accounting",
        expiresAt: Date.now() + 60000,
        readOnly: true,
        accounting,
      },
    })),
    { authorization: undefined },
    {
      authorization: {
        target,
        authorizationId: "x",
        expiresAt: 0,
        readOnly: true,
      },
    },
    {
      target: {
        ...target,
        project: "fneuqneqaopkmpeevlqz",
        endpoint: "https://fneuqneqaopkmpeevlqz.supabase.co/storage/v1",
      },
    },
  ])("rejects configuration/authority before network", async (options) => {
    const f = fixture(undefined, options);
    await expect(run(f)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.credentials).not.toHaveBeenCalled();
  });
  it("persists independent exact hash after preflight", async () => {
    const f = fixture();
    const r = await run(f);
    expect(r.inference).toBe("matches");
    expect(r.direct.bytes).toBe(3);
    expect(r.direct.sha256).toBe(target.intent.expectedSha256);
    expect(f.observations[0].phase).toBe("intent");
    expect(r.certified).toBe(false);
    expect(r.retainHolds).toBe(true);
    expect(r.operationId).not.toBe(f.observations[0].operationId);
  });
  it.each(["abd", "ab", ""])(
    "hash/size mismatch and truncation (%s)",
    async (body) => {
      const f = fixture(async () => new Response(body));
      expect((await run(f)).inference).toBe("mismatch");
    },
  );
  it.each([403, 404, 500])(
    "masked/error metadata %s stays ambiguous",
    async (status) => {
      const f = fixture(async () => new Response(null, { status }));
      const r = await run(f, "metadata");
      expect(r.direct.status).toBe(status);
      expect(r.inference).toBe("unknown");
    },
  );
  it.each([3, 4])("metadata size hint %s", async (size) => {
    const f = fixture(async () => Response.json({ size }));
    const r = await run(f, "metadata");
    expect(r.direct.bytes).toBe(size);
    expect(r.inference).toBe(size === 3 ? "matches" : "mismatch");
  });
  it.each([0, 100])("list pages always incomplete (%s)", async (n) => {
    const f = fixture(async () =>
      Response.json(Array.from({ length: n }, () => ({ name: "redacted" }))),
    );
    const r = await run(f, "list");
    expect(r.inference).toBe("incomplete");
    expect(r.direct.entries).toBe(n);
    expect(JSON.stringify(r)).not.toContain("redacted");
  });
  it.each([JSON.stringify(Array(101).fill({})), "[", "x".repeat(65537)])(
    "malformed/truncated/oversized listing unknown",
    async (body) => {
      const f = fixture(async () => new Response(body));
      expect((await run(f, "list")).inference).toBe("unknown");
    },
  );
  it("lost response remains unknown, never retries", async () => {
    const f = fixture(async () => {
      throw Error("lost");
    });
    expect((await run(f)).inference).toBe("unknown");
    await expect(run(f)).rejects.toThrow("PROBE_ATTEMPT_CONSUMED");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("persistence preflight failure prevents HTTP", async () => {
    const f = fixture();
    f.append.mockRejectedValueOnce(Error("database"));
    await expect(run(f)).rejects.toThrow("database");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("final persistence failure rejects without retry", async () => {
    const f = fixture();
    f.append.mockImplementation(async (v) => {
      if (v.phase === "result") throw Error("database");
    });
    await expect(run(f)).rejects.toThrow("database");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("only sends scoped read-only LIST with redirects disabled", async () => {
    const f = fixture(async () => Response.json([]));
    await run(f, "list");
    const [url, init] = f.fetch.mock.calls[0];
    expect(url).toContain("/object/list/private");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      prefix: "probe/",
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });
  });
});
describe("observer SQL binding", () => {
  it("persists bound provisional evidence and rejects lost commit", async () => {
    const f = fixture();
    const value = await run(f);
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      return {
        rows: sql.includes("AS allowed")
          ? [{ allowed: true }]
          : sql.includes("AS receipt")
            ? [{ receipt: id }]
            : [],
      };
    });
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) };
    const sink = new PostgresInspectionEvidence(
      pool,
      async () => id,
      async () => ({ intent: target.intent, scope: target.scope }),
    );
    await expect(sink.append(value)).resolves.toEqual({ receiptId: id });
    expect(
      query.mock.calls.some(
        ([sql]) => sql === "SET LOCAL ROLE ss_gateway_observer",
      ),
    ).toBe(true);
    const bound = query.mock.calls.find(([sql]) =>
      sql.includes("AS receipt"),
    )![1]!;
    expect(JSON.parse(bound[4] as string).outcome).toBe("ambiguous");
    query.mockImplementation(async (sql) => {
      if (sql === "COMMIT") throw Error("lost");
      return {
        rows: sql.includes("AS allowed")
          ? [{ allowed: true }]
          : sql.includes("AS receipt")
            ? [{ receipt: id }]
            : [],
      };
    });
    await expect(sink.append(value)).rejects.toThrow("lost");
    expect(release).toHaveBeenLastCalledWith(expect.any(Error));
  });
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProbeFence } from "../../src/lib/gateway/probe-fence.server";

describe("durable operation fence", () => {
  it("rejects cross-instance/restart replay while permitting a different read operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ss-read-probe-"));
    try {
      await new FileProbeFence(directory).claim("approval", "hash");
      await expect(
        new FileProbeFence(directory).claim("approval", "hash"),
      ).rejects.toThrow();
      await expect(
        new FileProbeFence(directory).claim("approval", "list"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("additional bounded faults", () => {
  it("retains ambiguity on timeout even if HTTP ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(() => new Promise(() => {}));
      const result = run(f);
      await vi.advanceTimersByTimeAsync(30001);
      expect((await result).inference).toBe("unknown");
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.observations).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects oversized GET without storing partial hash as complete", async () => {
    const f = fixture(async () => new Response(new Uint8Array(65537)));
    const r = await run(f);
    expect(r.inference).toBe("unknown");
    expect(r.direct.sha256).toBeNull();
  });
  it("records redirect as unknown and never follows it", async () => {
    const f = fixture(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.invalid" },
        }),
    );
    const r = await run(f);
    expect(r.inference).toBe("unknown");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("halts if durable fence fails before evidence or HTTP", async () => {
    const f = fixture(undefined, {
      fence: {
        claim: async () => {
          throw Error("consumed");
        },
      },
    });
    await expect(run(f)).rejects.toThrow("consumed");
    expect(f.append).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("fails on forged registered object scope", async () => {
    const f = fixture();
    const value = await run(f);
    const sink = new PostgresInspectionEvidence(
      {
        connect: async () => {
          throw Error("must not connect");
        },
      },
      async () => id,
      async () => ({
        intent: { ...target.intent, path: "other/key" },
        scope: target.scope,
      }),
    );
    await expect(sink.append(value)).rejects.toThrow(
      "REGISTERED_SCOPE_MISMATCH",
    );
  });
});

describe("response framing", () => {
  it("keeps truncated framing unknown even when payload matches the expected fixture", async () => {
    const f = fixture(
      async () => new Response("abc", { headers: { "Content-Length": "4" } }),
    );
    const r = await run(f);
    expect(r.inference).toBe("unknown");
    expect(r.direct.status).toBe(200);
    expect(r.direct.responseBytes).toBe(3);
  });
  it("rejects an advertised oversized body before reading it", async () => {
    const f = fixture(
      async () =>
        new Response("abc", { headers: { "Content-Length": "65537" } }),
    );
    const r = await run(f);
    expect(r.inference).toBe("unknown");
    expect(r.direct.responseBytes).toBe(0);
  });
  it("adds a bounded Range to the one GET attempt", async () => {
    const f = fixture();
    await run(f);
    expect(f.fetch.mock.calls[0][1].headers).toMatchObject({
      Range: "bytes=0-65535",
    });
  });
});

describe("operation identity", () => {
  it("keeps distinct durable keys for the three operations under one probe ID", async () => {
    const f = fixture(async () => Response.json([]));
    await run(f, "metadata");
    await run(f, "hash");
    await run(f, "list");
    expect(new Set(f.observations.map((v) => v.operationId)).size).toBe(6);
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it("rechecks authorization immediately before HTTP after credential acquisition", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(undefined, {
        credentials: async () => {
          vi.setSystemTime(Date.now() + 61000);
          return { bearer: "test", apiKey: "test" };
        },
      });
      expect((await run(f)).inference).toBe("unknown");
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("restricted observer failure boundaries", () => {
  it.each(["connect", "identity", "switch"])(
    "fails closed at %s without receipt retry",
    async (fault) => {
      const value = await run(fixture());
      const query = vi.fn(async (sql: string) => {
        if (fault === "switch" && sql.startsWith("SET LOCAL"))
          throw Error("denied");
        return {
          rows: sql.includes("AS allowed")
            ? [{ allowed: fault !== "identity" }]
            : [],
        };
      });
      const release = vi.fn();
      const connect = vi.fn(async () => {
        if (fault === "connect") throw Error("connection failed");
        return { query, release };
      });
      const sink = new PostgresInspectionEvidence(
        { connect },
        async () => id,
        async () => ({ intent: target.intent, scope: target.scope }),
      );
      await expect(sink.append(value)).rejects.toThrow();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query.mock.calls.some(([sql]) => sql.includes("AS receipt"))).toBe(
        false,
      );
      if (fault !== "connect")
        expect(release).toHaveBeenCalledWith(expect.any(Error));
    },
  );
  it("rejects a foreign trusted account before connecting", async () => {
    const value = await run(fixture());
    const connect = vi.fn();
    const sink = new PostgresInspectionEvidence(
      { connect },
      async () => "00000000-0000-4000-8000-000000000002",
      async () => ({ intent: target.intent, scope: target.scope }),
    );
    await expect(sink.append(value)).rejects.toThrow("FORBIDDEN");
    expect(connect).not.toHaveBeenCalled();
  });
});
