import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { enrollmentChecks } from "../fixtures/development-enrollment-checks";
vi.mock("server-only", () => ({}));
import { postgresPublisherIdentityProbe } from "../../src/lib/backend/development-publisher-postgres.server";

const owner = "00000000-0000-4000-8000-000000000123";
const other = "00000000-0000-4000-8000-000000000124";
const login = "ss_dev_cloud_publisher_login";
function fixture() {
  const user = {
    id: owner,
    role: "authenticated",
    is_anonymous: false,
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
  const claims = {
    sub: owner,
    role: "authenticated",
    is_anonymous: false,
    iss: "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1",
    exp: Date.now() / 1000 + 3600,
  };
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: { access_token: "fixture.payload.signature" } },
      error: null,
    })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    getClaims: vi.fn(async () => ({ data: { claims }, error: null })),
  };
  const row = {
    login,
    role: "ss_dev_cloud_publisher",
    read_only: "on",
    context_matches: true,
    legacy_clear: true,
    enrolled: true,
  };
  const clean = { login, role: login, clean: true };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    void values;
    return {
      rows: [
        sql.includes(" AS enrolled")
          ? row
          : sql.includes(" AS clean")
            ? clean
            : { login },
      ],
    };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const run = () =>
    postgresPublisherIdentityProbe(
      { connect } as unknown as Pick<Pool, "connect">,
      auth as unknown as SupabaseClient["auth"],
    );
  return { user, claims, auth, row, clean, query, release, connect, run };
}

it("uses fresh Auth on each side of checkout, fixed context and rollback-only SQL", async () => {
  const f = fixture();
  await expect(f.run()).resolves.toEqual({ verified: true });
  expect(f.auth.getUser).toHaveBeenCalledTimes(2);
  expect(f.auth.getUser.mock.invocationCallOrder[0]).toBeLessThan(
    f.connect.mock.invocationCallOrder[0],
  );
  expect(f.auth.getUser.mock.invocationCallOrder[1]).toBeGreaterThan(
    f.connect.mock.invocationCallOrder[0],
  );
  const sql = f.query.mock.calls.map(([sql]) => sql);
  expect(sql[0]).toBe("DISCARD ALL");
  expect(sql).toContain("BEGIN READ ONLY");
  expect(sql.filter((s) => s === "ROLLBACK")).toHaveLength(1);
  expect(sql).not.toContain("COMMIT");
  expect(sql.some((s) => /public\.ss_(?!dev_cloud_enrolled)/.test(s))).toBe(
    false,
  );
  const local = f.query.mock.calls.find(([sql]) => sql.includes("set_config"));
  expect(JSON.parse(local![1]![0] as string)).toEqual({
    sub: owner,
    role: "ss_dev_cloud_publisher",
    is_anonymous: false,
  });
  expect(f.release.mock.calls).toEqual([[false]]);
});

it.each([
  "enrolled",
  "role",
  "context_matches",
  "legacy_clear",
  "read_only",
  "login",
] as const)(
  "rejects false enrollment or forged/wrong context: %s",
  async (key) => {
    const f = fixture();
    Object.assign(f.row, {
      [key]: typeof f.row[key] === "boolean" ? false : "wrong",
    });
    await expect(f.run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
    expect(f.release).toHaveBeenLastCalledWith(true);
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  },
);

it.each(["expired", "revoked", "mismatch"])(
  "rejects %s Auth before checkout",
  async (kind) => {
    const f = fixture();
    if (kind === "expired") f.claims.exp = 1;
    if (kind === "revoked")
      f.auth.getUser.mockRejectedValueOnce(Error("private diagnostic"));
    if (kind === "mismatch") f.claims.sub = other;
    await expect(f.run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
    expect(f.connect).not.toHaveBeenCalled();
  },
);

it.each(["expired", "revoked", "switched"])(
  "rejects %s after waiting for checkout",
  async (kind) => {
    const f = fixture();
    f.connect.mockImplementationOnce(async () => {
      if (kind === "expired") f.claims.exp = 1;
      if (kind === "revoked")
        f.auth.getUser.mockRejectedValueOnce(Error("private diagnostic"));
      if (kind === "switched") {
        f.user.id = other;
        f.claims.sub = other;
      }
      return { query: f.query, release: f.release };
    });
    await expect(f.run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
    expect(
      f.query.mock.calls.some(([sql]) => sql.includes("ss_dev_cloud_enrolled")),
    ).toBe(false);
    expect(f.release).toHaveBeenLastCalledWith(true);
  },
);

it.each([
  "connect",
  "DISCARD ALL",
  "BEGIN READ ONLY",
  "set_config",
  " AS enrolled",
  "ROLLBACK",
  " AS clean",
  "release",
])(
  "sanitizes failure at %s, destroys uncertain checkout and never retries",
  async (stage) => {
    const f = fixture();
    if (stage === "connect")
      f.connect.mockRejectedValueOnce(Error("private diagnostic"));
    else if (stage === "release")
      f.release.mockImplementationOnce(() => {
        throw Error("private diagnostic");
      });
    else {
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sql, values) => {
        if (sql.includes(stage)) throw Error("private diagnostic");
        return original(sql, values);
      });
    }
    await expect(f.run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(
      f.query.mock.calls.filter(([sql]) => sql === "ROLLBACK").length,
    ).toBeLessThanOrEqual(1);
    if (stage !== "connect" && stage !== "release")
      expect(f.release).toHaveBeenLastCalledWith(true);
  },
);

it("destroys a connection when rollback returns but cleanup shows leaked context", async () => {
  const f = fixture();
  f.clean.clean = false;
  await expect(f.run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
  expect(f.release).toHaveBeenLastCalledWith(true);
});

it("rejects the wrong session LOGIN before switching role or binding claims", async () => {
  const f = fixture();
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    if (sql === "SELECT session_user AS login")
      return { rows: [{ login: "postgres" }] };
    return original(sql, values);
  });
  await expect(f.run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("SET LOCAL ROLE")),
  ).toBe(false);
  expect(f.release).toHaveBeenLastCalledWith(true);
});

it("destroys after a failed probe and failed rollback without retrying either", async () => {
  const f = fixture();
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    if (sql.includes(" AS enrolled") || sql === "ROLLBACK")
      throw Error("private diagnostic");
    return original(sql, values);
  });
  await expect(f.run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
  expect(f.query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(
    1,
  );
  expect(f.release).toHaveBeenLastCalledWith(true);
});

it("runs actual probe SQL against disposable enrollment with reused poisoned connections", async () => {
  const db = new PGlite();
  try {
    await enrollmentChecks(db, async () => {
      const f = fixture();
      const release = vi.fn();
      const query = async (sql: string, values?: unknown[]) => {
        if (sql === "DISCARD ALL") {
          await db.exec(sql);
          // Embedded engine cannot LOGIN; simulate the dedicated authenticated
          // connection after DISCARD resets session authorization.
          await db.exec(
            "SET SESSION AUTHORIZATION ss_dev_cloud_publisher_login",
          );
          return { rows: [] };
        }
        return db.query(sql, values);
      };
      const pool = {
        connect: async () => ({ query, release }),
      } as unknown as Pick<Pool, "connect">;
      const run = () =>
        postgresPublisherIdentityProbe(
          pool,
          f.auth as unknown as SupabaseClient["auth"],
        );
      await db.exec(
        "SET ROLE ss_dev_cloud_publisher; SET request.jwt.claims='{}'; SET request.jwt.claim.sub='poison'",
      );
      await expect(run()).resolves.toEqual({ verified: true });
      f.user.id = other;
      f.claims.sub = other;
      await expect(run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
      f.user.id = owner;
      f.claims.sub = owner;
      await expect(run()).resolves.toEqual({ verified: true });
      await db.exec(
        "SET SESSION AUTHORIZATION postgres; UPDATE app_private.dev_cloud_accounts SET enabled=false",
      );
      await expect(run()).rejects.toThrow(/^DEV_PUBLISHER_PROBE_FAILED$/);
      await db.exec(
        "SET SESSION AUTHORIZATION postgres; UPDATE app_private.dev_cloud_accounts SET enabled=true",
      );
      expect(release.mock.calls).toEqual([[false], [true], [false], [true]]);
    });
  } finally {
    await db.close();
  }
}, 30000);
