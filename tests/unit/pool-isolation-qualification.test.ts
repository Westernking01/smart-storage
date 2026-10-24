import { Client } from "pg";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runPoolIsolation } from "../../scripts/pool-isolation-qualification";
function fixture(failure = "") {
  const ids = [
    "00000000-0000-4000-8000-000000000123",
    "00000000-0000-4000-8000-000000000124",
  ];
  const history: { pid: number; sql: string; subject: string }[] = [];
  const accounts = ids.map((id) => ({
    id,
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "fixture.payload.signature" } },
        error: null,
      })),
      getUser: vi.fn(async () => ({
        data: {
          user: {
            id,
            role: "authenticated",
            is_anonymous: false,
            email_confirmed_at: "2026-01-01",
          },
        },
        error: null,
      })),
      getClaims: vi.fn(async () => ({
        data: {
          claims: {
            sub: id,
            role: "authenticated",
            is_anonymous: false,
            iss: "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1",
            exp: failure === "expired" ? 1 : Date.now() / 1000 + 600,
          },
        },
        error: null,
      })),
    },
  }));
  const idle: ReturnType<typeof make>[] = [],
    waiters: ((c: ReturnType<typeof make>) => void)[] = [];
  let created = 0;
  const releases: boolean[] = [];
  function make() {
    const pid = ++created;
    let subject = "",
      role = "ss_dev_cloud_publisher_login";
    const c = {
      query: vi.fn(async (sql: string, values?: string[]) => {
        history.push({ pid, sql, subject });
        if (sql === "DISCARD ALL") {
          subject = "";
          role = "ss_dev_cloud_publisher_login";
        }
        if (sql.startsWith("SET LOCAL ROLE")) role = "ss_dev_cloud_publisher";
        if (sql.includes("set_config")) subject = JSON.parse(values![0]).sub;
        if (sql === "ROLLBACK") {
          if (failure === "rollback") throw Error("secret");
          subject = "";
          role = "ss_dev_cloud_publisher_login";
        }
        if (sql.includes("pg_backend_pid"))
          return {
            rows: [
              {
                pid,
                login: "ss_dev_cloud_publisher_login",
                role,
                clean: subject === "",
              },
            ],
          };
        if (sql.includes("AS enrolled"))
          return {
            rows: [
              {
                login: "ss_dev_cloud_publisher_login",
                role,
                read_only: "on",
                context_matches:
                  JSON.parse(values![0]).sub === subject && failure !== "mix",
                legacy_clear: true,
                enrolled: failure !== "unenrolled",
              },
            ],
          };
        return {
          rows: [
            {
              login: "ss_dev_cloud_publisher_login",
              role,
              clean: failure !== "cleanup" && subject === "",
            },
          ],
        };
      }),
      release: (destroy: boolean) => {
        releases.push(destroy);
        if (!destroy) {
          const waiter = waiters.shift();
          if (waiter) waiter(c);
          else idle.push(c);
        }
      },
    };
    return c;
  }
  const db = {
    get totalCount() {
      return created;
    },
    get idleCount() {
      return idle.length;
    },
    get waitingCount() {
      return waiters.length;
    },
    connect: vi.fn(async () => {
      const c = idle.pop();
      if (c) return c;
      if (created < 2) return make();
      return new Promise<ReturnType<typeof make>>((resolve) =>
        waiters.push(resolve),
      );
    }),
    end: vi.fn(async () => {
      if (failure === "shutdown") throw Error("secret");
    }),
  };
  return {
    accounts,
    db,
    history,
    releases,
    run: (single = false) =>
      runPoolIsolation(
        db as never,
        (single ? accounts.slice(0, 1) : accounts) as never,
      ),
  };
}
it("uses A/B/A on one reset connection, then two concurrent sessions and a waiter", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result).toMatchObject({
    probes: 6,
    sessions: 2,
    maximumActive: 2,
    queued: true,
    crossUser: "PASS",
  });
  expect(
    f.history
      .filter((x) => x.sql.includes("set_config"))
      .slice(0, 3)
      .map((x) => x.pid),
  ).toEqual([1, 1, 1]);
  expect(f.history.filter((x) => x.sql === "DISCARD ALL")).toHaveLength(6);
  expect(f.history.filter((x) => x.sql === "ROLLBACK")).toHaveLength(6);
  expect(f.accounts[0].auth.getUser).toHaveBeenCalledTimes(8);
  expect(f.accounts[1].auth.getUser).toHaveBeenCalledTimes(4);
  expect(f.releases).toEqual(Array(6).fill(false));
  expect(f.db.end).toHaveBeenCalledOnce();
});
it("marks missing second user blocked", async () => {
  expect((await fixture().run(true)).crossUser).toContain("BLOCKED");
});
it.each(["expired", "rollback", "cleanup", "mix", "unenrolled", "shutdown"])(
  "halts and closes on %s",
  async (failure) => {
    const f = fixture(failure);
    await expect(f.run()).rejects.toThrow(
      /^(ISOLATION|IDENTITY_OR_ENROLLMENT|CLEANUP)_FAILED$/,
    );
    expect(f.db.end).toHaveBeenCalledOnce();
    if (failure !== "shutdown")
      expect(f.db.connect.mock.calls.length).toBeLessThanOrEqual(1);
    if (!["expired", "shutdown"].includes(failure))
      expect(f.releases).toEqual([true]);
  },
);
it("rejects revoked identity after checkout and destroys the client", async () => {
  const f = fixture();
  f.accounts[0].auth.getUser
    .mockResolvedValueOnce({
      data: {
        user: {
          id: f.accounts[0].id,
          role: "authenticated",
          is_anonymous: false,
          email_confirmed_at: "2026-01-01",
        },
      },
      error: null,
    })
    .mockRejectedValueOnce(Error("secret"));
  await expect(f.run()).rejects.toThrow("IDENTITY_OR_ENROLLMENT_FAILED");
  expect(f.releases).toEqual([true]);
  expect(f.db.end).toHaveBeenCalledOnce();
});

it("runs all six probes through installed pg-pool without a third construction", async () => {
  const { qualificationPool } =
    await import("../../scripts/pool-isolation-lifecycle");
  const f = fixture();
  const createState = f.db.connect.getMockImplementation()!;
  class OfflineClient extends Client {
    constructor(options?: ConstructorParameters<typeof Client>[0]) {
      super(options);
      const state = createState();
      this.connect = ((cb: (error: Error | null) => void) =>
        process.nextTick(() => cb(null))) as Client["connect"];
      this.query = (async (sql: string, values?: string[]) =>
        (await state).query(sql, values)) as Client["query"];
      this.end = ((cb?: () => void) => {
        if (cb) process.nextTick(cb);
        else return Promise.resolve();
      }) as Client["end"];
    }
  }
  const pool = qualificationPool(
    { connectionTimeoutMillis: 1000 },
    OfflineClient,
  );
  const evidence = await runPoolIsolation(pool, f.accounts as never);
  expect(evidence).toMatchObject({
    probes: 6,
    queries: 72,
    sessions: 2,
    maximumActive: 2,
    queued: true,
  });
  expect(pool.constructions).toBe(2);
  expect(pool.halted).toBe(false);
  expect(pool.ended).toBe(true);
});

it("classifies an initial connect rejection without exposing its diagnostic", async () => {
  const f = fixture();
  f.db.connect.mockRejectedValueOnce(
    Error("postgresql://private/token/account"),
  );
  await expect(f.run()).rejects.toThrow(/^DATABASE_CONNECT_FAILED$/);
  expect(f.db.end).toHaveBeenCalledOnce();
});
it("cleanup failure takes precedence over earlier expired identity", async () => {
  const f = fixture("expired");
  f.db.end.mockRejectedValueOnce(Error("private cleanup"));
  await expect(f.run()).rejects.toThrow(/^CLEANUP_FAILED$/);
});

async function scheduledPool(mode: string) {
  const { qualificationPool } =
    await import("../../scripts/pool-isolation-lifecycle");
  const f = fixture();
  const createState = f.db.connect.getMockImplementation()!;
  let constructed = 0,
    discards = 0,
    inspections = 0;
  class ScheduledClient extends Client {
    constructor(options?: ConstructorParameters<typeof Client>[0]) {
      super(options);
      const index = ++constructed;
      const state = createState();
      this.connect = ((cb: (error: Error | null) => void) => {
        if (
          (mode === "initial-stall" && index === 1) ||
          (mode === "second-stall" && index === 2)
        ) {
          (
            this as unknown as {
              connection: { stream: { destroy: () => void } };
            }
          ).connection.stream.destroy = () => cb(Error("timeout expired"));
        } else if (index === 2 && mode === "second-fail")
          setTimeout(() => cb(Error("private")), 100);
        else if (index === 2 && mode === "second-slow")
          setTimeout(() => cb(null), 500);
        else process.nextTick(() => cb(null));
      }) as Client["connect"];
      this.query = (async (sql: string, values?: string[]) => {
        if (sql.includes("pg_backend_pid")) inspections++;
        if (
          sql === "DISCARD ALL" &&
          ++discards > 3 &&
          mode.startsWith("work-slow")
        )
          await new Promise((resolve) => setTimeout(resolve, 6000));
        if (mode === "work-slow-cleanup" && discards > 3 && sql === "ROLLBACK")
          throw Error("private cleanup");
        return (await state).query(sql, values);
      }) as Client["query"];
      this.end = ((cb?: () => void) => {
        if (cb) process.nextTick(cb);
        else return Promise.resolve();
      }) as Client["end"];
    }
  }
  if (mode === "third-auth-fail" || mode === "third-auth-slow") {
    const original = f.accounts[0].auth.getUser.getMockImplementation()!;
    let checks = 0;
    f.accounts[0].auth.getUser.mockImplementation(async () => {
      if (++checks === 11) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (mode === "third-auth-fail") throw Error("private");
      }
      return original();
    });
  }
  const pool = qualificationPool(
    { connectionTimeoutMillis: 5000 },
    ScheduledClient,
  );
  const result = runPoolIsolation(pool, f.accounts.slice(0, 1) as never).then(
    (evidence) => ({ evidence }),
    (error: unknown) => ({ error }),
  );
  return {
    pool,
    result,
    observations: () => ({ inspections, discards, constructed }),
  };
}
it.each(["second-slow", "third-auth-slow", "work-slow"])(
  "completes clean handoff with %s",
  async (mode) => {
    vi.useFakeTimers();
    try {
      const f = await scheduledPool(mode);
      await vi.advanceTimersByTimeAsync(20000);
      const result = await f.result;
      expect(result).toHaveProperty("evidence.queued", true);
      expect(result).toHaveProperty("evidence.probes", 6);
      expect(f.pool.constructions).toBe(2);
      expect(f.pool.ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  },
);
it.each([
  "initial-stall",
  "second-stall",
  "second-fail",
  "third-auth-fail",
  "work-slow-cleanup",
])("fails and closes installed pool after %s", async (mode) => {
  const { failureLine } = await import("../../scripts/pool-isolation-errors");
  vi.useFakeTimers();
  try {
    const f = await scheduledPool(mode);
    await vi.advanceTimersByTimeAsync(13000);
    const result = await f.result;
    expect(result).toHaveProperty("error");
    const line = failureLine("error" in result ? result.error : undefined);
    if (mode === "work-slow-cleanup") expect(line).toBe("FAIL: CLEANUP_FAILED");
    if (mode === "initial-stall")
      expect(line).toBe(
        "FAIL: CONNECTION_TIMEOUT STAGE=CONNECTION_ESTABLISHMENT PHASE=SEQUENTIAL",
      );

    if (mode === "second-fail")
      expect(line).toBe("FAIL: DATABASE_CONNECT_FAILED");
    if (mode === "third-auth-fail") {
      expect(line).toBe("FAIL: IDENTITY_OR_ENROLLMENT_FAILED");
      expect(f.observations().inspections).toBe(5);
    }
    expect(f.pool.ended).toBe(true);
    expect(f.pool.waitingCount).toBe(0);
    expect(f.pool.constructions).toBeLessThanOrEqual(2);
  } finally {
    vi.useRealTimers();
  }
});
