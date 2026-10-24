import { Client, type PoolClient } from "pg";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { postgresPublisherIdentityProbe } from "../../src/lib/backend/development-publisher-postgres.server";
import { qualificationPool } from "../../scripts/pool-isolation-lifecycle";
import { connectionStage } from "../../scripts/pool-isolation-errors";

// Offline scheduling proposal only. The executable runner remains unchanged.
async function proposal(mode: "normal" | "queue-timeout" | "cleanup-failure") {
  const id = "00000000-0000-4000-8000-000000000123";
  let queries = 0,
    authChecks = 0,
    transactions = 0,
    rollback = 0,
    queued = false;
  let failed = false;
  let queueStage = "UNKNOWN";
  let phase = false,
    heldCount = 0,
    completed = 0;
  const held: PoolClient[] = [];
  let admit!: () => void;
  const cleanLeases = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const events: string[] = [];
  let clientIndex = 0;
  class OfflineClient extends Client {
    constructor(options?: ConstructorParameters<typeof Client>[0]) {
      super(options);
      const index = ++clientIndex;
      let role = "ss_dev_cloud_publisher_login",
        claims = "",
        inTransaction = false;
      this.connect = ((cb: (error: Error | null) => void) =>
        process.nextTick(() => cb(null))) as Client["connect"];
      this.query = (async (sql: string, values?: string[]) => {
        queries++;
        if (sql === "DISCARD ALL") {
          if (
            inTransaction ||
            claims ||
            role !== "ss_dev_cloud_publisher_login"
          )
            throw Error("leak before reset");
        }
        if (sql === "BEGIN READ ONLY") {
          inTransaction = true;
          transactions++;
        }
        if (sql.startsWith("SET LOCAL ROLE")) role = "ss_dev_cloud_publisher";
        if (sql.includes("set_config")) claims = values![0];
        if (sql.includes("AS enrolled")) {
          // Valid Auth and SQL each take six seconds, below their respective
          // existing per-operation deadlines. No simulated SQL writes.
          await new Promise((resolve) => setTimeout(resolve, 6000));
          return {
            rows: [
              {
                login: "ss_dev_cloud_publisher_login",
                role,
                read_only: "on",
                context_matches: JSON.parse(claims).sub === id,
                legacy_clear: true,
                enrolled: true,
              },
            ],
          };
        }
        if (sql === "ROLLBACK") {
          inTransaction = false;
          role = "ss_dev_cloud_publisher_login";
          claims = "";
          rollback++;
        }
        if (sql.includes("AS clean")) {
          events.push("clean");
          return {
            rows: [
              {
                login: "ss_dev_cloud_publisher_login",
                role,
                clean:
                  !inTransaction &&
                  claims === "" &&
                  !(mode === "cleanup-failure" && phase && index === 2),
              },
            ],
          };
        }
        return { rows: [{ login: "ss_dev_cloud_publisher_login" }] };
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
  const auth = {
    getSession: async () => ({
      data: { session: { access_token: "fixture.payload.signature" } },
      error: null,
    }),
    getUser: async () => {
      authChecks++;
      events.push("auth");
      await new Promise((resolve) => setTimeout(resolve, 6000));
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
  };
  const db = {
    connect: async () => {
      const pending = pool.connect();
      if (phase && heldCount === 2) {
        queued =
          pool.waitingCount === 1 &&
          pool.totalCount === 2 &&
          pool.idleCount === 0;
        events.push("queued");
        const handoff = () => {
          for (const c of held.splice(0)) c.release();
        };
        if (mode === "queue-timeout") setTimeout(handoff, 6000);
        else handoff();
      }
      const client = await pending.catch((error: unknown) => {
        queueStage = connectionStage(error);
        throw error;
      });
      const release = client.release.bind(client);
      return {
        query: client.query.bind(client),
        release: (destroy: boolean) => {
          if (phase && heldCount < 2 && !destroy) {
            held.push({ release } as PoolClient);
            heldCount++;
            if (heldCount === 2) {
              events.push("admit-third");
              admit();
            }
          } else release(destroy);
        },
      } as PoolClient;
    },
  };
  const probe = async () => {
    await postgresPublisherIdentityProbe(db as never, auth as never);
    completed++;
  };
  try {
    await probe();
    await probe();
    await probe();
    phase = true;
    const firstTwo = [probe(), probe()];
    const third = (async () => {
      await cleanLeases;
      if (failed) throw Error("proposal stopped");
      await probe();
    })();
    const results = await Promise.allSettled([
      ...firstTwo.map((p) =>
        p.catch((error: unknown) => {
          failed = true;
          admit();
          throw error;
        }),
      ),
      third,
    ]);
    return {
      results,
      queueStage,
      closed: pool,
      completed,
      queued,
      authChecks,
      queries,
      transactions,
      rollback,
      events,
      constructions: pool.constructions,
    };
  } finally {
    for (const c of held.splice(0)) c.release(true);
    await pool.end();
  }
}

it("proposed clean handoff queues successfully despite six-second valid Auth and SQL work", async () => {
  vi.useFakeTimers();
  try {
    const pending = proposal("normal");
    await vi.advanceTimersByTimeAsync(110000);
    const r = await pending;
    expect(r.results.every((x) => x.status === "fulfilled")).toBe(true);
    expect(r).toMatchObject({
      completed: 6,
      queued: true,
      constructions: 2,
      authChecks: 12,
      transactions: 6,
      rollback: 6,
    });
    expect(r.queries).toBeLessThanOrEqual(120);
    const admission = r.events.indexOf("admit-third");
    expect(
      r.events.slice(0, admission).filter((e) => e === "clean"),
    ).toHaveLength(5);
    expect(r.events[admission + 1]).toBe("auth");
    expect(r.events.indexOf("queued")).toBeGreaterThan(admission);
  } finally {
    vi.useRealTimers();
  }
});
it("proposed handoff still fails the unchanged five-second queue limit if release is withheld", async () => {
  vi.useFakeTimers();
  try {
    const pending = proposal("queue-timeout");
    await vi.advanceTimersByTimeAsync(110000);
    const r = await pending;
    const rejected = r.results.find((x) => x.status === "rejected");
    expect(rejected).toBeDefined();
    // The probe masks the raw queue error; it never reports successful completion.
    expect(r.completed).toBe(5);
    expect(r.constructions).toBe(2);
    expect(r.queueStage).toBe("CHECKOUT_QUEUE");
  } finally {
    vi.useRealTimers();
  }
});
it("proposed handoff never admits a third probe on failed cleanup", async () => {
  vi.useFakeTimers();
  try {
    const pending = proposal("cleanup-failure");
    await vi.advanceTimersByTimeAsync(110000);
    const r = await pending;
    expect(r.results.some((x) => x.status === "rejected")).toBe(true);
    expect(r.completed).toBe(4);
    expect(r.authChecks).toBe(10);
    expect(r.closed.ended).toBe(true);
    expect(r.queued).toBe(false);
    expect(r.constructions).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
