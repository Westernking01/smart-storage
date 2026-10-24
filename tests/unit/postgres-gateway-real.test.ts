// Opt-in, exact-target local PostgreSQL integration. No credential file is read.
import { readFileSync, appendFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  PsqlTestClient,
  runtimePool,
} from "../database/gateway-214h-psql-client";
import { PostgresAuthority } from "../../src/lib/gateway/postgres-authority.server";
import { PostgresEvidence } from "../../src/lib/gateway/postgres-evidence.server";
import { createPostgresStorageProvider } from "../../src/lib/gateway/postgres-provider.server";
import { executorTransaction } from "../../src/lib/gateway/postgres-runtime.server";
import type {
  ProvisionalObservation,
  StorageTransport,
  WriteIntent,
} from "../../src/lib/gateway/provider-contracts";

const passfile = process.env.SMART_STORAGE_RUNTIME_PASSFILE;
const enabled =
  process.env.SMART_STORAGE_LOCAL_GATEWAY_TEST === "214h-final" && !!passfile;
const data = Buffer.from("12345678");
const hash = createHash("sha256").update(data).digest("hex");
const admin = () =>
  new PsqlTestClient(
    "postgres",
    "C:/ProgramData/SmartStoragePgTest/pgpass.conf",
  );
async function inspect(sql: string) {
  const c = admin();
  try {
    return (await c.query(sql)).rows[0]?.value;
  } finally {
    c.release();
  }
}
async function fixture() {
  const namespace = randomUUID().slice(0, 8);
  const id = (prefix: string, k = 1) =>
    `${prefix}${namespace.slice(1)}-214f-4000-8000-${String(k).padStart(12, "0")}`;
  let sql = readFileSync(
    "tests/database/gateway-claims-fixture.sql",
    "utf8",
  ).replace(/([0-9a-d])0000000-0000-0000-0000-/g, (_, p: string) =>
    id(p).slice(0, 24),
  );
  for (const [table, p] of [
    ["auth.users", "0"],
    ["public.files", "1"],
    ["public.upload_sessions", "2"],
    ["public.file_blocks", "3"],
  ])
    sql = sql.replaceAll(
      `from ${table};`,
      `from ${table} where id::text like '${id(p).slice(0, 24)}%';`,
    );
  // Identity is immutable after INSERT; set the real stream digest at creation.
  sql = sql.replaceAll("repeat('a',64)", `'${hash}'`);
  appendFileSync(
    "tests/database/gateway-214h-final-fixture-journal.jsonl",
    JSON.stringify({
      namespace,
      state: "planned",
      timestamp: new Date().toISOString(),
      ownerIds: [id("0"), id("0", 2)],
      sessionIds: [1, 2, 3, 4].map((n) => id("2", n)),
    }) + "\n",
  );
  await inspect(`BEGIN; ${sql} COMMIT`);
  appendFileSync(
    "tests/database/gateway-214h-final-fixture-journal.jsonl",
    JSON.stringify({
      namespace,
      state: "committed",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  const path = String(
    await inspect(
      `SELECT object_path FROM public.transfer_attempts WHERE id='${id("4")}'`,
    ),
  );
  const intent: WriteIntent = {
    ownerId: id("0"),
    executorId: id("6"),
    requestId: id("5"),
    resourceId: id("7"),
    sessionId: id("2"),
    fileId: id("1"),
    attemptId: id("4"),
    epoch: 1,
    dispatchGeneration: 1,
    bucket: "local-gateway-test",
    path,
    declaredBytes: 8,
    expectedSha256: hash,
    operation: "single-object-create",
  };
  const pool = runtimePool(passfile!);
  await executorTransaction(pool, async (c) => {
    await c.query(
      "SELECT public.ss_gateway_claim_v1($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid)",
      [
        intent.ownerId,
        intent.attemptId,
        intent.requestId,
        8,
        intent.executorId,
      ],
    );
    await c.query(
      "SELECT public.ss_gateway_register_resource_v1($1::uuid,$2::uuid,$3::uuid,$4::bigint,'object',$5::text,$6::jsonb,$7::bigint)",
      [
        intent.ownerId,
        intent.requestId,
        intent.resourceId,
        1,
        path,
        JSON.stringify({
          namespace: "local-214h-final-" + namespace,
          uploadId: null,
          version: null,
          generation: null,
        }),
        8,
      ],
    );
  });
  const identity = async () => ({
    ownerId: intent.ownerId,
    executorId: intent.executorId,
  });
  return {
    intent,
    pool,
    identity,
    authority: new PostgresAuthority(pool, identity),
    evidence: new PostgresEvidence(pool, identity),
    otherOwnerId: id("0", 2),
  };
}
function observation(intent: WriteIntent): ProvisionalObservation {
  return {
    intent,
    decisionId: intent.requestId,
    writerId: intent.executorId,
    reservationId: intent.sessionId,
    exposureId: intent.resourceId,
    maximumEncodedBytes: 8,
    reservedExposureBytes: 8,
    classification: "provisional",
    startedAt: 1,
    finishedAt: 1,
    state: "dispatch-intent",
    reason: "DISPATCH_INTENT",
    inputBytes: 0,
    forwardedBytes: 0,
    sha256: null,
    digestComplete: false,
    response: null,
    evidencePersistence: "pending-durable-ack",
    futureProviderEffectsPossible: true,
    retainHolds: true,
    certified: false,
  };
}
const source = async function* () {
  yield data;
};
const response = {
  kind: "response",
  status: 200,
  provenance: "authenticated-storage-response",
  requestId: null,
  version: null,
  etag: null,
  acknowledgedBytes: 8,
} as const;
it.skipIf(process.env.SMART_STORAGE_LOCAL_GATEWAY_TEST !== "214h-final")(
  "checks the exact local catalog and persistent psql test bridge without runtime credentials",
  async () => {
    const c = admin();
    try {
      expect(
        (
          await c.query(
            "SELECT current_database()='smart_storage_gateway_test' AND current_setting('server_version')='17.11' AND inet_server_addr()='127.0.0.1'::inet",
          )
        ).rows[0]?.value,
      ).toBe("t");
      expect(
        (await c.query("SELECT $1::text", ["quote' and slash\\"])).rows[0]
          ?.value,
      ).toBe("quote' and slash\\");
      await c.query("BEGIN READ ONLY");
      await c.query("SET LOCAL ROLE ss_gateway_executor");
      expect((await c.query("SELECT current_user")).rows[0]?.value).toBe(
        "ss_gateway_executor",
      );
      await c.query("ROLLBACK");
      expect((await c.query("SELECT current_user")).rows[0]?.value).toBe(
        "postgres",
      );
    } finally {
      c.release();
    }
  },
);
describe.skipIf(!enabled)("real restricted PostgreSQL gateway", () => {
  it("authenticates independently, switches explicitly, resets privileges, denies forbidden routes/RPCs/tables/roles", async () => {
    const c = new PsqlTestClient("ss_gateway_runtime_test", passfile!);
    try {
      expect((await c.query("SELECT current_user")).rows[0]?.value).toBe(
        "ss_gateway_runtime_test",
      );
      await executorTransaction(
        {
          connect: async () => ({
            ...c,
            query: c.query.bind(c),
            release: () => {},
          }),
        },
        async (client) => {
          expect(
            (await client.query("SELECT current_user")).rows[0]?.value,
          ).toBe("ss_gateway_executor");
        },
      );
      expect((await c.query("SELECT current_user")).rows[0]?.value).toBe(
        "ss_gateway_runtime_test",
      );
      await expect(
        executorTransaction(
          {
            connect: async () => ({
              query: c.query.bind(c),
              release: () => {},
            }),
          },
          async () => {
            throw Error("ROLLBACK_TEST");
          },
        ),
      ).rejects.toThrow("ROLLBACK_TEST");
      expect((await c.query("SELECT current_user")).rows[0]?.value).toBe(
        "ss_gateway_runtime_test",
      );
    } finally {
      c.release();
    }
    for (const sql of [
      "SELECT public.ss_gateway_resolve_dispatch_v1(null,null,null,null,1,1)",
      "SELECT * FROM app_private.gateway_requests",
      "SET ROLE postgres",
      "SET ROLE ss_gateway_cleaner",
    ]) {
      const denied = new PsqlTestClient("ss_gateway_runtime_test", passfile!);
      try {
        await expect(denied.query(sql)).rejects.toThrow();
      } finally {
        denied.release();
      }
    }
    for (const [db, host] of [
      ["postgres", "127.0.0.1"],
      ["template1", "127.0.0.1"],
      ["smart_storage_gateway_test", "::1"],
    ]) {
      const denied = new PsqlTestClient(
        "ss_gateway_runtime_test",
        passfile!,
        db,
        host,
      );
      try {
        await expect(denied.query("SELECT 1")).rejects.toThrow();
      } finally {
        denied.release();
      }
    }
  }, 30000);
  it("rejects forged scope/stale fencing and serializes independent concurrent dispatch with no replay", async () => {
    const f = await fixture();
    const crossAccount = new PostgresAuthority(f.pool, async () => ({
      ownerId: f.otherOwnerId,
      executorId: f.intent.executorId,
    }));
    await expect(
      crossAccount.consumeDispatch({ ...f.intent, ownerId: f.otherOwnerId }),
    ).rejects.toThrow("FORBIDDEN");
    for (const changes of [
      { epoch: 2 },
      { dispatchGeneration: 2 },
      { path: "forged" },
      { fileId: randomUUID() },
      { ownerId: randomUUID() },
      { executorId: randomUUID() },
    ])
      await expect(
        f.authority.consumeDispatch({ ...f.intent, ...changes }),
      ).rejects.toThrow();
    const blocker = admin();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM public.upload_sessions WHERE id=$1::uuid FOR UPDATE",
      [f.intent.sessionId],
    );
    const competing = Promise.allSettled([
      f.authority.consumeDispatch(f.intent),
      f.authority.consumeDispatch(f.intent),
    ]);
    let overlap = false;
    try {
      for (let n = 0; n < 30; n++) {
        if (
          (await inspect(
            "SELECT count(*)>=2 FROM pg_stat_activity WHERE usename='ss_gateway_runtime_test' AND wait_event_type='Lock' AND query LIKE '%ss_gateway_resolve_dispatch_v1%'",
          )) === "t"
        ) {
          overlap = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const results = await competing;
    expect(overlap).toBe(true);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
    await expect(f.authority.consumeDispatch(f.intent)).rejects.toThrow(
      "ALREADY_DISPATCHED",
    );
  }, 30000);
  it("persists immutable intent/response, enforces idempotency/conflicts and retains holds", async () => {
    const f = await fixture();
    await f.authority.consumeDispatch(f.intent);
    const before = await inspect(
      `SELECT json_build_array(s.held_bytes,s.slot_held,u.reserved_bytes,u.active_slots)::text FROM public.upload_sessions s JOIN public.user_usage u ON u.owner_id=s.owner_id WHERE s.id='${f.intent.sessionId}'`,
    );
    const intent = observation(f.intent);
    const first = await f.evidence.append(intent);
    expect(await f.evidence.append(intent)).toEqual(first);
    const final = {
      ...intent,
      state: "response-observed" as const,
      reason: "EXACT_STREAM_RESPONSE_OBSERVED",
      inputBytes: 8,
      forwardedBytes: 8,
      sha256: hash,
      digestComplete: true,
      response,
    };
    await f.evidence.append(final);
    await expect(
      f.evidence.append({ ...final, reason: "CONFLICT" }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(
      await inspect(
        `SELECT count(*) FROM app_private.gateway_write_observations WHERE request_id='${f.intent.requestId}'`,
      ),
    ).toBe("2");
    expect(
      await inspect(
        `SELECT json_build_array(s.held_bytes,s.slot_held,u.reserved_bytes,u.active_slots)::text FROM public.upload_sessions s JOIN public.user_usage u ON u.owner_id=s.owner_id WHERE s.id='${f.intent.sessionId}'`,
      ),
    ).toBe(before);
  }, 30000);
  it.each(["success", "timeout", "transport-failure"])(
    "integrates the unchanged streaming adapter: %s",
    async (mode) => {
      const f = await fixture();
      const snapshotSql = `SELECT json_build_array(s.held_bytes,s.slot_held,u.reserved_bytes,u.active_slots)::text FROM public.upload_sessions s JOIN public.user_usage u ON u.owner_id=s.owner_id WHERE s.id='${f.intent.sessionId}'`;
      const holdsBefore = await inspect(snapshotSql);
      const transport: StorageTransport = {
        assertSupported: () => {},
        create: async ({ body }) => {
          if (mode === "timeout") return new Promise(() => {});
          for await (const chunk of body) void chunk;
          if (mode === "transport-failure") throw Error("LOCAL_FAULT");
          return response;
        },
      };
      const provider = createPostgresStorageProvider(
        f.pool,
        f.identity,
        transport,
        { timeoutMs: 50, maximumChunkBytes: 65536 },
      );
      const result = await provider.write(f.intent, source());
      expect(result.evidencePersistence).toBe("durable-acknowledged");
      expect(result.observation.state).toBe(
        mode === "success" ? "response-observed" : "ambiguous",
      );
      expect(result.observation.retainHolds).toBe(true);
      expect(result.observation.certified).toBe(false);
      expect(await inspect(snapshotSql)).toBe(holdsBefore);
      expect(
        await inspect(
          `SELECT count(*) FROM app_private.gateway_write_observations WHERE request_id='${f.intent.requestId}'`,
        ),
      ).toBe("2");
    },
    30000,
  );
  it("preserves durable consumption and evidence when commit acknowledgments are lost", async () => {
    const f = await fixture();
    const lostPool = {
      connect: async () => {
        const c = await f.pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await c.query(sql, values);
            if (sql === "COMMIT") throw Error("LOST_COMMIT_ACK");
            return result;
          },
          release: c.release.bind(c),
        };
      },
    };
    await expect(
      new PostgresAuthority(lostPool, f.identity).consumeDispatch(f.intent),
    ).rejects.toThrow("LOST_COMMIT_ACK");
    await expect(f.authority.consumeDispatch(f.intent)).rejects.toThrow();
    const intent = observation(f.intent);
    await expect(
      new PostgresEvidence(lostPool, f.identity).append(intent),
    ).rejects.toThrow("LOST_COMMIT_ACK");
    expect((await f.evidence.append(intent)).receiptId).toBeTruthy();
    expect(
      await inspect(
        `SELECT slot_held FROM public.upload_sessions WHERE id='${f.intent.sessionId}'`,
      ),
    ).toBe("t");
  }, 30000);
});
