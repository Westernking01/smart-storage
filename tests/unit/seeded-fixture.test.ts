import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  seededFixtureSchema,
  type SeededFixture,
} from "../../src/lib/gateway/seeded-fixture-contract";
import {
  SeededFixtureObserver,
  registerSeededFixture,
  composeSeededFixtureProbe,
} from "../../src/lib/gateway/seeded-fixture.server";
import { ReadOnlyInspectionRunner } from "../../src/lib/gateway/inspection-runner.server";
import {
  seededInspectionSchema,
  inspectionSchema,
} from "../../src/lib/gateway/inspection-evidence.server";
import { intentSchema } from "../../src/lib/gateway/supabase-storage-provider.server";
import type { GatewayPostgresPool } from "../../src/lib/gateway/postgres-runtime.server";
import { SupabaseStorageTransport } from "../../src/lib/gateway/supabase-storage-transport.server";
import { authenticateProbeHost } from "../../src/lib/gateway/probe-auth-host.server";

const owner = "310d0ec8-84ca-423a-b646-0480a20edc09";
const hash = "57d60b8f171ecb27ee614e0a518b3bfba7d8c994bb4daf20c496818970d4c511";
const evidenceDirectory =
  "C:\\Users\\Admin\\Desktop\\NEW\\smart-storage-probe-evidence";
let db: PGlite;
let fixture: SeededFixture;
let registrationId: string;
const sqlFile = new URL(
  "../database/seeded-fixture-inspection.sql",
  import.meta.url,
);
function observation(
  kind: "metadata" | "hash" | "list" = "metadata",
  phase: "intent" | "result" = "intent",
) {
  return seededInspectionSchema.parse({
    operationId: randomUUID(),
    intent: fixture,
    scope: {
      namespace: fixture.project,
      uploadId: null,
      version: null,
      generation: null,
    },
    kind,
    phase,
    listing:
      kind === "list"
        ? { prefix: "gateway-probe/v1/", offset: 0, limit: 100 }
        : null,
    observedAt: new Date().toISOString(),
    direct: {
      status: null,
      bytes: null,
      responseBytes: null,
      sha256: null,
      entries: null,
    },
    inference: phase === "intent" ? "pending" : "unknown",
    classification: "provisional",
    retainHolds: true,
    certified: false,
    futureProviderEffectsPossible: true,
  });
}
async function receipt(value: unknown, id = registrationId, uid = owner) {
  return db.query(
    "select public.ss_seeded_fixture_receipt_v1($1::uuid,$2::uuid,$3::jsonb) as receipt",
    [id, uid, JSON.stringify(value)],
  );
}

describe("seeded inspection SQL on disposable in-memory PostgreSQL (no installed-cluster authentication)", () => {
  beforeAll(async () => {
    const bootstrap = new PGlite();
    await bootstrap.exec("create database smart_storage_gateway_test");
    const snapshot = await bootstrap.dumpDataDir();
    await bootstrap.close();
    db = new PGlite({
      database: "smart_storage_gateway_test",
      loadDataDir: snapshot,
    });
    await db.exec(
      "create role ss_gateway_observer; create role ss_gateway_executor; create role ss_gateway_finalizer; create role ss_gateway_cleaner; create role anon; create role authenticated; create role service_role; create role ss_gateway_observer_runtime_test noinherit;",
    );
    await db.exec(await readFile(sqlFile, "utf8"));
    const result = await db.query<{ id: string }>(
      "select public.ss_seeded_fixture_register_v1($1,clock_timestamp()+interval '20 minutes') as id",
      ["operator independently verified original local fixture"],
    );
    registrationId = result.rows[0].id;
    const resolved = await db.query<{ fixture: unknown }>(
      "select public.ss_seeded_fixture_resolve_v1($1,$2) as fixture",
      [registrationId, owner],
    );
    fixture = seededFixtureSchema.parse(resolved.rows[0].fixture);
  }, 180000);
  afterAll(async () => {
    await db?.close();
  });
  it("generates inspection-only identity in the database and pins the complete fixture", () => {
    expect(fixture).toMatchObject({
      registrationId,
      declaredBytes: 123,
      expectedSha256: hash,
      ownerId: owner,
      provenance: "externally-seeded-operator-fixture",
    });
    expect(intentSchema.safeParse(fixture).success).toBe(false);
    expect(inspectionSchema.safeParse(observation()).success).toBe(false);
    expect(Object.keys(fixture)).not.toEqual(
      expect.arrayContaining(["attemptId"]),
    );
  });
  it("rejects duplicate registration and invalid expiry", async () => {
    await expect(
      db.query(
        "select public.ss_seeded_fixture_register_v1('duplicate',clock_timestamp()+interval '20 minutes')",
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "select public.ss_seeded_fixture_register_v1('expired',clock_timestamp()-interval '1 second')",
      ),
    ).rejects.toThrow();
  });
  it("denies registration, direct table access and receipt issuance to unrelated roles", async () => {
    for (const role of [
      "anon",
      "authenticated",
      "service_role",
      "ss_gateway_executor",
      "ss_gateway_finalizer",
      "ss_gateway_cleaner",
      "ss_gateway_observer_runtime_test",
    ]) {
      await db.exec(`set role ${role}`);
      await expect(
        db.query(
          "select public.ss_seeded_fixture_register_v1('forged',clock_timestamp()+interval '10 minutes')",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("select * from app_private.seeded_fixture_registrations"),
      ).rejects.toThrow(/permission denied/);
      await expect(receipt(observation())).rejects.toThrow(/permission denied/);
      await expect(
        db.query("select public.ss_seeded_fixture_resolve_v1($1,$2)", [
          registrationId,
          owner,
        ]),
      ).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
  });
  it("observer can resolve but cannot register, mutate registrations or promote anything", async () => {
    await db.exec("set role ss_gateway_observer");
    const result = await db.query<{ fixture: unknown }>(
      "select public.ss_seeded_fixture_resolve_v1($1,$2) as fixture",
      [registrationId, owner],
    );
    expect(seededFixtureSchema.parse(result.rows[0].fixture)).toEqual(fixture);
    await expect(
      db.query(
        "select public.ss_seeded_fixture_register_v1('forged',clock_timestamp()+interval '10 minutes')",
      ),
    ).rejects.toThrow(/permission denied/);
    for (const command of ["select * from", "delete from", "update"]) {
      await expect(
        db.query(
          `${command} app_private.seeded_fixture_receipts${command === "update" ? " set producer='forged'" : ""}`,
        ),
      ).rejects.toThrow(/permission denied/);
    }
    await db.exec("reset role");
  });
  it("rejects missing registration, owner mismatch and forged provenance", async () => {
    await db.exec("set role ss_gateway_observer");
    await expect(receipt(observation(), randomUUID())).rejects.toThrow(
      /FORBIDDEN/,
    );
    await expect(
      receipt(observation(), registrationId, randomUUID()),
    ).rejects.toThrow(/FORBIDDEN/);
    for (const patch of [
      { project: "fneuqneqaopkmpeevlqz" },
      { provenance: "gateway-upload" },
      { path: "gateway-probe/v1/other" },
      { declaredBytes: 124 },
      { expectedSha256: "0".repeat(64) },
    ]) {
      await expect(
        receipt({ ...observation(), intent: { ...fixture, ...patch } }),
      ).rejects.toThrow(/EVIDENCE_MISMATCH/);
    }
    await expect(
      receipt({ ...observation(), certified: true }),
    ).rejects.toThrow(/EVIDENCE_MISMATCH/);
    await expect(
      receipt({
        ...observation(),
        direct: { ...observation().direct, entries: 101 },
      }),
    ).rejects.toThrow(/EVIDENCE_MISMATCH/);
    await expect(
      receipt({
        ...observation("list"),
        listing: { prefix: "", offset: 0, limit: 100 },
      }),
    ).rejects.toThrow(/EVIDENCE_MISMATCH/);
    await db.exec("reset role");
  });
  it("requires durable intent before result, rejects exact duplicates and changed evidence", async () => {
    await db.exec("set role ss_gateway_observer");
    await expect(receipt(observation("metadata", "result"))).rejects.toThrow(
      /MISSING_INSPECTION_INTENT/,
    );
    const first = observation();
    await receipt(first);
    await expect(receipt(first)).rejects.toThrow(/unique/);
    await expect(
      receipt({ ...first, operationId: randomUUID(), inference: "unknown" }),
    ).rejects.toThrow(/unique/);
    await receipt(observation("metadata", "result"));
    await db.exec("reset role");
    const rows = await db.query<{ count: number }>(
      "select count(*)::int as count from app_private.seeded_fixture_receipts",
    );
    expect(rows.rows[0].count).toBe(2);
  });
  it("rollback leaves no receipt and only restricted observer issues receipts", async () => {
    await expect(receipt(observation("list"))).rejects.toThrow(
      /RESTRICTED_OBSERVER_REQUIRED/,
    );
    await db.exec("begin; set local role ss_gateway_observer");
    await receipt(observation("list"));
    await db.exec("rollback");
    const rows = await db.query<{ count: number }>(
      "select count(*)::int as count from app_private.seeded_fixture_receipts where kind='list'",
    );
    expect(rows.rows[0].count).toBe(0);
  });
  it("has no upload ledger or write authority dependency", async () => {
    const rows = await db.query<{ name: string }>(
      "select tablename as name from pg_catalog.pg_tables where schemaname='app_private' order by tablename",
    );
    expect(rows.rows.map((r) => r.name)).toEqual([
      "seeded_fixture_receipts",
      "seeded_fixture_registrations",
    ]);
  });
  it("persists real SQL receipts from the existing runner using genuine registration", async () => {
    // This test adapter models the separately tested login check only. All binds,
    // role switching, scope resolution, receipts and commits use the real engine.
    const pool: GatewayPostgresPool = {
      connect: async () => ({
        query: async (sql, values) =>
          sql.includes("AS allowed")
            ? { rows: [{ allowed: true }] }
            : db.query(sql, values),
        release: () => {},
      }),
    };
    const composed = await composeSeededFixtureProbe({
      observerPool: pool,
      trustedOwner: async () => owner,
      registrationId,
      evidenceDirectory,
      restrictedAclReviewed: true,
    });
    const target = composed.target;
    const http = vi.fn(async () => new Response("[]"));
    const runner = new ReadOnlyInspectionRunner({
      enabled: true,
      ...composed,
      fence: { claim: async () => {} },
      authorization: {
        target,
        authorizationId: randomUUID(),
        expiresAt: Date.now() + 60000,
        readOnly: true,
        accounting: "accepted-raw-response-body",
      },
      credentials: async () => ({ bearer: "mock", apiKey: "mock" }),
      fetch: http,
    });
    expect(
      (await runner.run("list", randomUUID(), new AbortController().signal))
        .inference,
    ).toBe("incomplete");
    expect(http.mock.calls).toHaveLength(1);
    const result = await db.query<{ count: number }>(
      "select count(*)::int as count from app_private.seeded_fixture_receipts where kind='list'",
    );
    expect(result.rows[0].count).toBe(2);
  });
  it("rejects stale registration at resolution and receipt persistence", async () => {
    // Trusted test-only fixture clock adjustment, confined to this disposable DB.
    await db.exec(
      "update app_private.seeded_fixture_registrations set created_at=clock_timestamp()-interval '30 minutes',expires_at=clock_timestamp()-interval '1 second'",
    );
    await db.exec("set role ss_gateway_observer");
    await expect(
      db.query("select public.ss_seeded_fixture_resolve_v1($1,$2)", [
        registrationId,
        owner,
      ]),
    ).rejects.toThrow(/STALE_SEEDED_REGISTRATION/);
    await expect(receipt(observation("list"))).rejects.toThrow(
      /STALE_SEEDED_REGISTRATION/,
    );
    await db.exec("reset role");
  });
});

function fakePool(
  options: { allowed?: boolean; fail?: string; binding?: SeededFixture } = {},
) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (options.fail && sql.includes(options.fail))
      throw Error("lost persistence acknowledgment");
    if (sql.includes("AS allowed"))
      return { rows: [{ allowed: options.allowed ?? true }] };
    if (sql.includes("AS fixture"))
      return { rows: [{ fixture: options.binding ?? fixture }] };
    if (sql.includes("AS registration"))
      return { rows: [{ registration: registrationId }] };
    if (sql.includes("AS receipt"))
      return { rows: [{ receipt: randomUUID() }] };
    return { rows: [] };
  });
  const pool: GatewayPostgresPool = {
    connect: async () => ({ query, release }),
  };
  return { pool, query, release };
}
describe("seeded observer bindings and existing runner", () => {
  it("enforces operator authorization before registration connections", async () => {
    const { pool, query } = fakePool();
    await expect(
      registerSeededFixture(pool, {
        authorized: false,
        verificationReference: "source",
        expiresAt: Date.now() + 60000,
      } as never),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(
      await registerSeededFixture(pool, {
        authorized: true,
        verificationReference: "source",
        expiresAt: Date.now() + 60000,
      }),
    ).toBe(registrationId);
  });
  it("rejects wrong database/login and discards uncertain connections", async () => {
    const { pool, query, release } = fakePool({ allowed: false });
    const sink = new SeededFixtureObserver(
      pool,
      async () => owner,
      registrationId,
    );
    await expect(sink.resolve()).rejects.toThrow(
      /RESTRICTED_SEEDED_DATABASE_REQUIRED/,
    );
    expect(
      query.mock.calls.some(([s]) => s.includes("ss_seeded_fixture_resolve")),
    ).toBe(false);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
  it("requires independent trusted owner and exact registered binding", async () => {
    const { pool } = fakePool();
    await expect(
      new SeededFixtureObserver(
        pool,
        async () => randomUUID(),
        registrationId,
      ).resolve(),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      new SeededFixtureObserver(pool, async () => owner, registrationId).append(
        {
          ...observation(),
          intent: { ...fixture, verificationReference: "forged" },
        },
      ),
    ).rejects.toThrow(/REGISTERED_SCOPE_MISMATCH/);
  });
  it.each(["ss_seeded_fixture_receipt_v1", "COMMIT"])(
    "fails on %s persistence loss without retry",
    async (fail) => {
      const { pool, query, release } = fakePool({ fail });
      await expect(
        new SeededFixtureObserver(
          pool,
          async () => owner,
          registrationId,
        ).append(observation()),
      ).rejects.toThrow(/lost persistence/);
      expect(
        query.mock.calls.filter(([s]) =>
          s.includes("ss_seeded_fixture_receipt_v1"),
        ),
      ).toHaveLength(1);
      expect(release).toHaveBeenCalledWith(expect.any(Error));
    },
  );
  function runner(overrides: Record<string, unknown> = {}) {
    const target = {
      project: fixture.project,
      endpoint: `https://${fixture.project}.supabase.co/storage/v1`,
      prefix: "gateway-probe/v1",
      intent: fixture,
      scope: observation().scope,
    };
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ size: 123 })),
    );
    const credentials = vi.fn(async () => ({ bearer: "mock", apiKey: "mock" }));
    const append = vi.fn(async () => ({ receiptId: randomUUID() }));
    const claim = vi.fn(async () => {});
    const options = {
      enabled: true,
      target,
      authorization: {
        target,
        authorizationId: randomUUID(),
        expiresAt: Date.now() + 60000,
        readOnly: true as const,
        accounting: "accepted-raw-response-body" as const,
      },
      credentials,
      fetch,
      sink: { append },
      fence: { claim },
      resolveSeeded: async () => fixture,
      ...overrides,
    };
    return {
      instance: new ReadOnlyInspectionRunner(options),
      fetch,
      credentials,
      append,
      claim,
    };
  }
  it("runs seeded metadata through the existing bounded runner with separate provenance", async () => {
    const f = runner();
    const result = await f.instance.run(
      "metadata",
      randomUUID(),
      new AbortController().signal,
    );
    expect(result.intent).toEqual(fixture);
    expect(result.inference).toBe("matches");
    expect(f.append).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await expect(
      f.instance.run("metadata", randomUUID(), new AbortController().signal),
    ).rejects.toThrow(/CONSUMED/);
  });
  it("supports bounded GET/hash and scoped LIST without write capability", async () => {
    for (const kind of ["hash", "list"] as const) {
      const fetch = vi.fn(
        async () => new Response(kind === "hash" ? "x".repeat(123) : "[]"),
      );
      const f = runner({ fetch });
      const result = await f.instance.run(
        kind,
        randomUUID(),
        new AbortController().signal,
      );
      expect(result.inference).toBe(
        kind === "hash" ? "mismatch" : "incomplete",
      );
      expect(result.certified).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn();
    const credentials = vi.fn();
    const transport = new SupabaseStorageTransport({
      enabled: true,
      endpoint: `https://${fixture.project}.supabase.co/storage/v1`,
      bucket: fixture.bucket,
      prefix: "gateway-probe/v1",
      maximumEncodedBytes: 65536,
      timeoutMs: 30000,
      fetch,
      credentials,
      report: async () => {},
      exposureBound: () => null,
    });
    await expect(
      transport.deleteForTest(
        fixture as never,
        async () => true,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      transport.create({ intent: fixture } as never),
    ).rejects.toThrow();
    expect(credentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses missing resolver, stale registration and persistence/fence failure before HTTP", async () => {
    for (const overrides of [
      { enabled: false },
      { authorization: undefined },
      { resolveSeeded: undefined },
      { resolveSeeded: async () => ({ ...fixture, expiresAt: 1 }) },
      {
        sink: {
          append: async () => {
            throw Error("persistence failed");
          },
        },
      },
      {
        fence: {
          claim: async () => {
            throw Error("fence failed");
          },
        },
      },
    ]) {
      const f = runner(overrides);
      await expect(
        f.instance.run("metadata", randomUUID(), new AbortController().signal),
      ).rejects.toThrow();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.credentials).not.toHaveBeenCalled();
    }
  });
  it("composes the registered observer and existing durable fence with pinned destination", async () => {
    const { pool } = fakePool();
    const composed = await composeSeededFixtureProbe({
      observerPool: pool,
      trustedOwner: async () => owner,
      registrationId,
      evidenceDirectory,
      restrictedAclReviewed: true,
    });
    expect(composed.target.intent).toEqual(fixture);
    expect(await composed.resolveSeeded()).toEqual(fixture);
    await expect(
      composeSeededFixtureProbe({
        observerPool: pool,
        trustedOwner: async () => owner,
        registrationId,
        evidenceDirectory: "C:\\wrong",
        restrictedAclReviewed: true,
      }),
    ).rejects.toThrow(/DESTINATION/);
  });
  it("uses the existing Auth host's in-process runProbe for seeded inspection (all HTTP mocked)", async () => {
    const load = async (name: string) =>
      JSON.parse(
        await readFile(
          new URL(
            `../../experiments/storage/disposable-probe.${name}.template.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    const now = Date.now();
    const plan = await load("auth");
    const review = Object.fromEntries(
      Object.entries(await load("permissions")).map(([k, v]) => [
        k,
        v === false
          ? true
          : k === "reviewReference"
            ? "mock independent policy review"
            : v,
      ]),
    );
    const auth = {
      ...(await load("auth-authorization")),
      enabled: true,
      authorizationId: randomUUID(),
      issuedAt: now,
      expiresAt: now + 120000,
      physicalOverheadUnboundedAcknowledged: true,
      evidenceDirectory,
      restrictedAclReviewed: true,
    };
    const token = [
      "e30",
      Buffer.from(
        JSON.stringify({
          iss: auth.authEndpoint,
          sub: owner,
          role: "authenticated",
          aud: "authenticated",
          exp: Math.floor(now / 1000) + 3600,
        }),
      ).toString("base64url"),
      "mock-signature",
    ].join(".");
    const http = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/user")
              ? { id: owner, role: "authenticated" }
              : {
                  access_token: token,
                  refresh_token: "mock-unused",
                  token_type: "bearer",
                  user: { id: owner },
                },
          ),
        ),
    );
    const probeHttp = vi.fn(async () => new Response('{"size":123}'));
    const session = await authenticateProbeHost({
      plan,
      review,
      authorization: auth,
      readMaskedCredentials: async () => ({
        apiKey: "sb_publishable_mockonly123",
        email: "fixture@example.invalid",
        password: "mock-password",
      }),
      confirm: async () => true,
      http,
      probeHttp,
      fence: { claim: async () => {} },
    });
    try {
      const { pool } = fakePool();
      const composed = await composeSeededFixtureProbe({
        observerPool: pool,
        trustedOwner: async () => owner,
        registrationId,
        evidenceDirectory,
        restrictedAclReviewed: true,
      });
      const config = {
        ...(await load("config")),
        enabled: true,
        independentFixtureVerification: fixture.verificationReference,
        destinations: composed.destinations,
      };
      const authorization = {
        ...(await load("authorization")),
        independentFixtureVerification: fixture.verificationReference,
        destinations: composed.destinations,
        authorizationId: randomUUID(),
        issuedAt: now,
        expiresAt: now + 120000,
        physicalOverheadUnboundedAcknowledged: true,
      };
      const result = await session.runProbe(
        {
          ...composed,
          fence: { claim: async () => {} },
          config,
          authorization,
        },
        "metadata",
        randomUUID(),
        new AbortController().signal,
      );
      expect(result.intent).toEqual(fixture);
      expect(result.inference).toBe("matches");
      expect(http).toHaveBeenCalledTimes(2);
      expect(probeHttp).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
    }
  });
});
