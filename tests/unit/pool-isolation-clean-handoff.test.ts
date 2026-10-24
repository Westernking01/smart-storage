import { Client, type PoolClient } from "pg";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runPoolIsolation } from "../../scripts/pool-isolation-qualification";
import { qualificationPool } from "../../scripts/pool-isolation-lifecycle";
import { failureLine } from "../../scripts/pool-isolation-errors";

// Real runner and installed pg-pool; fake transport/Auth only, no sockets.
async function scenario(mode: string) {
  let queries = 0,
    checks = 0,
    rollbacks = 0,
    checkouts = 0,
    shutdowns = 0;
  const events: string[] = [],
    owners: string[] = [];
  const states: { role: string; claims: string; transaction: boolean }[] = [];
  let observedCleanQueue = false;
  const login = "ss_dev_cloud_publisher_login";
  class OfflineClient extends Client {
    constructor(options?: ConstructorParameters<typeof Client>[0]) {
      super(options);
      const pid = states.length + 1;
      const state = { role: login, claims: "", transaction: false };
      states.push(state);
      this.connect = ((cb: (error: Error | null) => void) =>
        process.nextTick(() => cb(null))) as Client["connect"];
      this.query = (async (sql: string, values?: string[]) => {
        queries++;
        if (sql.includes("pg_backend_pid"))
          return {
            rows: [
              {
                pid,
                login,
                role: state.role,
                clean: !state.transaction && state.claims === "",
              },
            ],
          };
        if (
          sql === "DISCARD ALL" &&
          (state.transaction || state.claims || state.role !== login)
        )
          throw Error("leaked context");
        if (sql === "BEGIN READ ONLY") state.transaction = true;
        if (sql.startsWith("SET LOCAL ROLE"))
          state.role = "ss_dev_cloud_publisher";
        if (sql.includes("set_config")) {
          state.claims = values![0];
          owners.push(JSON.parse(state.claims).sub);
        }
        if (sql.includes("AS enrolled")) {
          await new Promise((resolve) => setTimeout(resolve, 6000));
          return {
            rows: [
              {
                login,
                role: state.role,
                read_only: "on",
                context_matches: state.claims === values![0],
                legacy_clear: true,
                enrolled: true,
              },
            ],
          };
        }
        if (sql === "ROLLBACK") {
          if (mode === "rollback-failure" && pid === 2)
            throw Error("private rollback");
          state.transaction = false;
          state.role = login;
          state.claims = "";
          rollbacks++;
        }
        if (sql.includes("AS clean")) {
          events.push("clean");
          return {
            rows: [
              {
                login,
                role: state.role,
                clean:
                  !state.transaction &&
                  !state.claims &&
                  !(mode === "cleanup-failure" && pid === 2),
              },
            ],
          };
        }
        return { rows: [{ login }] };
      }) as Client["query"];
      this.end = ((cb?: () => void) => {
        if (cb) process.nextTick(cb);
        else return Promise.resolve();
      }) as Client["end"];
    }
  }
  const pool = qualificationPool(
    { connectionTimeoutMillis: 5000 },
    OfflineClient,
  );
  const db = {
    get totalCount() {
      return pool.totalCount;
    },
    get idleCount() {
      return pool.idleCount;
    },
    get waitingCount() {
      if (mode === "claim-leak") states[0].claims = "poisoned";
      observedCleanQueue =
        pool.waitingCount === 1 &&
        pool.totalCount === 2 &&
        pool.idleCount === 0 &&
        states.every((s) => !s.transaction && s.role === login && !s.claims);
      events.push("observe-queue");
      if (mode === "observation-throw") throw Error("private observation");
      return mode === "bad-observation" ? 0 : pool.waitingCount;
    },
    connect: () => {
      const number = ++checkouts;
      if (number === 6) events.push("request-six");
      const pending = pool.connect();
      return pending.then((client) => {
        if (number === 6) events.push("acquire-six");
        const release = client.release.bind(client);
        return {
          query: client.query.bind(client),
          release: (destroy = false) => {
            const handoff = !destroy && (number === 4 || number === 5);
            if (handoff) events.push("handoff-release");
            if (mode === "queue-timeout" && handoff) {
              setTimeout(() => release(false), 6000);
              return;
            }
            release(destroy);
            if (mode === "release-failure" && number === 5)
              throw Error("private release");
            if (mode === "abort-release-failure" && number === 4 && destroy)
              throw Error("private abort release");
          },
        } as PoolClient;
      });
    },
    end: async () => {
      shutdowns++;
      await pool.end();
      if (mode === "shutdown-failure") throw Error("private shutdown");
    },
  };
  const ids = [
    "00000000-0000-4000-8000-000000000123",
    "00000000-0000-4000-8000-000000000124",
  ];
  const accounts = ids.map((id) => ({
    id,
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "fixture.payload.signature" } },
        error: null,
      }),
      getUser: async () => {
        checks++;
        events.push("auth");
        await new Promise((resolve) => setTimeout(resolve, 6000));
        if (
          (mode === "six-auth-failure" || mode === "abort-release-failure") &&
          checks === 11
        )
          throw Error("private auth");
        if (mode === "post-auth-failure" && checks === 12)
          throw Error("private revoked identity");
        return {
          data: {
            user: {
              id,
              role: "authenticated",
              is_anonymous: false,
              email_confirmed_at: "2026-01-01",
            },
          },
          error: null,
        };
      },
      getClaims: async () => ({
        data: {
          claims: {
            sub: id,
            role: "authenticated",
            is_anonymous: false,
            iss: "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1",
            exp: Date.now() / 1000 + 600,
          },
        },
        error: null,
      }),
    },
  }));
  const result = await runPoolIsolation(db, accounts as never).then(
    (evidence) => ({ evidence }),
    (error: unknown) => ({ error }),
  );
  return {
    result,
    pool,
    queries,
    checks,
    rollbacks,
    checkouts,
    shutdowns,
    events,
    owners,
    ids,
    observedCleanQueue,
  };
}
it("clean handoff succeeds with slow valid Auth/SQL, fresh identity and isolated claims", async () => {
  vi.useFakeTimers();
  try {
    const pending = scenario("normal");
    await vi.advanceTimersByTimeAsync(110000);
    const r = await pending;
    expect(r.result).toHaveProperty("evidence.queued", true);
    expect(r.result).toHaveProperty("evidence.probes", 6);
    expect(r).toMatchObject({
      checks: 12,
      queries: 72,
      rollbacks: 6,
      checkouts: 6,
      shutdowns: 1,
      observedCleanQueue: true,
    });
    expect(r.owners).toEqual([
      r.ids[0],
      r.ids[1],
      r.ids[0],
      r.ids[0],
      r.ids[1],
      r.ids[0],
    ]);
    const sixth = r.events.indexOf("request-six");
    expect(r.events.slice(0, sixth).filter((e) => e === "clean")).toHaveLength(
      5,
    );
    expect(r.events[sixth - 1]).toBe("auth");
    expect(r.events.slice(sixth, sixth + 4)).toEqual([
      "request-six",
      "observe-queue",
      "handoff-release",
      "handoff-release",
    ]);
    expect(r.events.slice(r.events.indexOf("acquire-six") + 1)).toContain(
      "auth",
    );
    expect(r.pool.constructions).toBe(2);
    expect(r.pool.ended).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  "rollback-failure",
  "cleanup-failure",
  "release-failure",
  "abort-release-failure",
  "shutdown-failure",
  "bad-observation",
  "observation-throw",
  "queue-timeout",
  "six-auth-failure",
  "post-auth-failure",
  "claim-leak",
])("fails closed and shuts down on %s", async (mode) => {
  vi.useFakeTimers();
  try {
    const pending = scenario(mode);
    await vi.advanceTimersByTimeAsync(110000);
    const r = await pending;
    expect(r.result).toHaveProperty("error");
    const line = failureLine("error" in r.result ? r.result.error : undefined);
    if (mode === "queue-timeout")
      expect(line).toBe(
        "FAIL: CONNECTION_TIMEOUT STAGE=CHECKOUT_QUEUE PHASE=CONCURRENT",
      );
    else if (["six-auth-failure", "post-auth-failure"].includes(mode))
      expect(line).toBe("FAIL: IDENTITY_OR_ENROLLMENT_FAILED");
    else if (mode === "claim-leak") expect(line).toBe("FAIL: ISOLATION_FAILED");
    else if (!["bad-observation", "observation-throw"].includes(mode))
      expect(line).toBe("FAIL: CLEANUP_FAILED");
    if (
      mode === "rollback-failure" ||
      mode === "cleanup-failure" ||
      mode === "six-auth-failure" ||
      mode === "abort-release-failure"
    )
      expect(r.checkouts).toBe(5);
    expect(r.pool.constructions).toBeLessThanOrEqual(2);
    expect(r.pool.waitingCount).toBe(0);
    expect(r.pool.ended).toBe(true);
    expect(r.shutdowns).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
