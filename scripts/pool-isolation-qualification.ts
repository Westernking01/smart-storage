import { createClient } from "@supabase/supabase-js";
import { type Pool, type PoolClient } from "pg";
import { qualificationPool } from "./pool-isolation-lifecycle";
import { z } from "zod";
import { qualificationConfig } from "./publisher-tls-qualification";
import { qualificationFetch } from "./enrollment-auth-qualification";
import { postgresPublisherIdentityProbe } from "../src/lib/backend/development-publisher-postgres.server";

import {
  PoolFailure,
  connectionCategory,
  connectionStage,
  dominant,
  failureLine,
  type FailureCategory,
  type TimeoutStage,
  type TimeoutPhase,
} from "./pool-isolation-errors";

type Auth = Parameters<typeof postgresPublisherIdentityProbe>[1];
type Account = { auth: Auth; id: string };
type Database = Pick<
  Pool,
  "connect" | "end" | "totalCount" | "idleCount" | "waitingCount"
>;
const inspect =
  "SELECT pg_catalog.pg_backend_pid() AS pid, session_user AS login, current_user AS role, nullif(pg_catalog.current_setting('request.jwt.claims',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim.role',true),'') IS NULL AS clean";
export const poolLimits = {
  probes: 6,
  queries: 120,
  connections: 2,
  auth: 64,
  milliseconds: 120000,
} as const;

export async function runPoolIsolation(db: Database, accounts: Account[]) {
  const evidence = {
    probes: 0,
    queries: 0,
    sessions: 0,
    maximumActive: 0,
    queued: false,
    crossUser:
      accounts.length === 2 ? "PASS" : "BLOCKED_SECOND_ACCOUNT_UNAVAILABLE",
  };
  const sessions = new Set<number>();
  let recorded: FailureCategory | undefined;
  let timeoutEvidence: { stage: TimeoutStage; phase: TimeoutPhase } | undefined;
  const record = (category: FailureCategory) => {
    recorded = recorded ? dominant(recorded, category) : category;
  };
  let active = 0,
    stopped = false;
  const deadline = Date.now() + poolLimits.milliseconds;
  const guard = () => {
    if (stopped || Date.now() >= deadline) throw Error();
  };
  const count = () => {
    if (++evidence.queries > poolLimits.queries || Date.now() >= deadline)
      throw Error();
  };
  const held = new Map<PoolClient, (destroy: boolean) => void>();
  const releaseHeld = (destroy: boolean) => {
    for (const [client, release] of held) {
      held.delete(client);
      try {
        release(destroy);
      } catch {
        record("CLEANUP_FAILED");
        stopped = true;
      }
    }
  };
  let concurrent = false;
  const used: number[] = [];
  const probe = async (account: Account, hold = false, handoff = false) => {
    guard();
    if (++evidence.probes > poolLimits.probes) throw Error();
    const auth: Auth = {
      getSession: account.auth.getSession.bind(account.auth),
      getClaims: account.auth.getClaims.bind(account.auth),
      getUser: async (token) => {
        guard();
        const result = await account.auth.getUser(token);
        if (result.error || result.data.user?.id !== account.id) throw Error();
        return result;
      },
    };
    const wrapped = {
      connect: async () => {
        guard();
        let client: PoolClient;
        try {
          const pending = db.connect();
          if (handoff) {
            // No await, Auth, SQL or timer between observing the real waiter
            // and releasing the verified-clean leases.
            let observed = false;
            try {
              observed =
                held.size === 2 &&
                active === 2 &&
                db.totalCount === 2 &&
                db.idleCount === 0 &&
                db.waitingCount === 1;
            } catch {
              /* Failed observation still requires draining pending. */
            }
            if (!observed) {
              record("ISOLATION_FAILED");
              stopped = true;
              releaseHeld(true);
            } else {
              evidence.queued = true;
              releaseHeld(false);
            }
          }
          // Drain even after observation/release failure; destroy late leases.
          client = await pending;
          if (stopped) {
            try {
              client.release(true);
            } catch {
              record("CLEANUP_FAILED");
            }
            throw new PoolFailure(recorded ?? "ISOLATION_FAILED");
          }
        } catch (error) {
          const category = connectionCategory(error);
          if (category === "CONNECTION_TIMEOUT" && !timeoutEvidence)
            timeoutEvidence = {
              stage: connectionStage(error),
              phase: concurrent ? "CONCURRENT" : "SEQUENTIAL",
            };
          record(category);
          throw new PoolFailure(category);
        }
        active++;

        evidence.maximumActive = Math.max(evidence.maximumActive, active);
        let released = false;
        const actualRelease = (destroy = true) => {
          if (!released) {
            released = true;
            active--;
            try {
              client.release(destroy);
            } catch {
              record("CLEANUP_FAILED");
              throw new PoolFailure("CLEANUP_FAILED");
            }
          }
        };
        try {
          guard();
          if (active > 2) throw Error();
          count();
          const result = await client.query(inspect);
          const row = result.rows[0];
          if (
            result.rows.length !== 1 ||
            !Number.isInteger(row.pid) ||
            row.login !== "ss_dev_cloud_publisher_login" ||
            row.role !== row.login ||
            row.clean !== true
          )
            throw Error();
          sessions.add(row.pid);
          if (sessions.size > 2) throw Error();
          used.push(row.pid);
          guard();
          return {
            query: async (sql: string, values?: unknown[]) => {
              count();
              return client.query(sql, values);
            },
            release: (destroy = true) => {
              // The fixed probe calls release(false) only after verified rollback
              // and clean LOGIN/empty claims. Never defer a failed release.
              if (hold && !destroy && !stopped) held.set(client, actualRelease);
              else actualRelease(destroy || stopped);
            },
          } as unknown as PoolClient;
        } catch {
          record("ISOLATION_FAILED");
          actualRelease(true);
          throw Error();
        }
      },
    } as unknown as Pick<Pool, "connect">;
    try {
      await postgresPublisherIdentityProbe(wrapped, auth);
    } catch (error) {
      const stage = (error as { qualificationCategory?: unknown })
        ?.qualificationCategory;
      if (stage === "CLEANUP_FAILED") record("CLEANUP_FAILED");
      else if (
        stage === "AUTH_VALIDATION_FAILED" ||
        stage === "ENROLLMENT_DENIED"
      )
        record("IDENTITY_OR_ENROLLMENT_FAILED");
      else if (!recorded) record("ISOLATION_FAILED");
      stopped = true;
      releaseHeld(true);
      throw new PoolFailure(recorded!);
    }
  };
  try {
    if (
      accounts.length < 1 ||
      accounts.length > 2 ||
      accounts.some((a) => !z.uuid().safeParse(a.id).success) ||
      (accounts.length === 2 && accounts[0].id === accounts[1].id)
    )
      throw Error();
    const a = accounts[0],
      b = accounts[1] ?? a;
    await probe(a);
    await probe(b);
    await probe(a);
    if (new Set(used).size !== 1) throw Error();
    concurrent = true;
    const results = await Promise.allSettled([probe(a, true), probe(b, true)]);
    if (
      results.some((r) => r.status === "rejected") ||
      stopped ||
      held.size !== 2
    )
      throw Error();
    await probe(a, false, true);
    if (!evidence.queued || evidence.maximumActive !== 2 || sessions.size !== 2)
      throw Error();
    evidence.sessions = sessions.size;
    return evidence;
  } catch {
    throw new PoolFailure(
      recorded ?? "ISOLATION_FAILED",
      timeoutEvidence?.stage,
      timeoutEvidence?.phase,
    );
  } finally {
    stopped = true;
    releaseHeld(true);
    try {
      await db.end();
    } catch {
      throw new PoolFailure("CLEANUP_FAILED");
    }
    if (recorded === "CLEANUP_FAILED") throw new PoolFailure("CLEANUP_FAILED");
  }
}

export const poolFailureLine = failureLine;

if (process.argv[2] === "--pool-execute") {
  let db: ReturnType<typeof qualificationPool> | undefined;
  const watchdog = setTimeout(() => {
    console.error(failureLine(new PoolFailure("CLEANUP_FAILED")));
    process.exit(1);
  }, poolLimits.milliseconds);
  let failed: unknown;
  try {
    const config = qualificationConfig(process.env);
    if (process.env.SMART_STORAGE_DEV_CLOUD_PUBLISHER) throw Error();
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
    if (!key.startsWith("sb_publishable_") || key.length > 512) throw Error();
    let dispatches = 0;
    let networkFailed = false;
    db = qualificationPool(config);
    const accounts: Account[] = [];
    for (const label of ["A", "B"]) {
      const prefix = `SMART_STORAGE_POOL_${label}_`;
      const id = process.env[prefix + "ID"];
      if (!id && label === "B") continue;
      z.uuid().parse(id);
      const credentials = {
        email: process.env[prefix + "EMAIL"] ?? "",
        password: process.env[prefix + "PASSWORD"] ?? "",
      };
      if (
        !z.email().safeParse(credentials.email).success ||
        credentials.email.length > 254 ||
        !credentials.password ||
        credentials.password.length > 1024
      )
        throw Error();
      for (const suffix of ["ID", "EMAIL", "PASSWORD"])
        delete process.env[prefix + suffix];
      const bounded = qualificationFetch(async (input, init) => {
        if (networkFailed || ++dispatches > poolLimits.auth) throw Error();
        try {
          const response = await fetch(input, init);
          if (!response.ok) networkFailed = true;
          return response;
        } catch {
          networkFailed = true;
          throw Error();
        }
      }, 24);
      // Per-account endpoint budget is stricter than the shared 64 ceiling.
      // One-account mode performs six probes, hence up to 24 user requests.
      const authFetch: typeof fetch = bounded;
      const client = createClient(
        "https://fneuqneqaopkmpeevlqz.supabase.co",
        key,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
          global: { fetch: authFetch },
        },
      );
      const signed = await client.auth.signInWithPassword(credentials);
      credentials.password = "";
      if (signed.error)
        throw new PoolFailure(
          [400, 401, 403].includes(signed.error.status ?? 0)
            ? "AUTH_REJECTED"
            : "IDENTITY_OR_ENROLLMENT_FAILED",
        );
      accounts.push({ auth: client.auth, id: id! });
    }
    delete process.env.SMART_STORAGE_DEV_CLOUD_DATABASE_URL;
    const owned = db;
    db = undefined;
    const evidence = await runPoolIsolation(owned, accounts);
    if (owned.halted)
      throw new PoolFailure(owned.failureCategory ?? "POOL_LIFECYCLE_FAILED");
    console.log(
      JSON.stringify({
        status: evidence.crossUser === "PASS" ? "PASS" : "PARTIAL",
        ...evidence,
        authDispatches: dispatches,
        connections: owned.constructions,
      }),
    );
  } catch (error) {
    failed = error;
    process.exitCode = 1;
  } finally {
    if (db)
      await db.end().catch(() => {
        failed = new PoolFailure("CLEANUP_FAILED");
        process.exitCode = 1;
      });
    if (process.exitCode) console.error(failureLine(failed));
    clearTimeout(watchdog);
  }
}
