import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, vi } from "vitest";
import { postgresAttemptClaims } from "../../experiments/storage/disposable-postgres-claims";
import { disposableUploadTarget as t } from "../../experiments/storage/disposable-upload-contract";

const key = `${t.project}/${t.bucket}/${t.key}/upload`;
const session = {
  source: "external-verified-ordinary-session" as const,
  userId: t.userId,
  issuer: "https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1" as const,
  role: "authenticated" as const,
  accessToken: "synthetic",
  expiresAt: 2000,
};
describe("PostgreSQL claim transport (offline)", () => {
  it.each(["true", "false"])(
    "accepts only bounded boolean %s",
    async (body) => {
      const transport = vi.fn<typeof fetch>(async () => new Response(body));
      const claim = postgresAttemptClaims({
        session,
        publicKey: "synthetic",
        transport,
        check: () => {},
      });
      expect(await claim(key)).toBe(body === "true");
      await expect(claim(key)).rejects.toThrow("CLAIM_ATTEMPT_USED");
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][0]).toBe(
        `https://${t.project}.supabase.co/rest/v1/rpc/smart_storage_claim_once`,
      );
      expect(transport.mock.calls[0][1]).toMatchObject({
        redirect: "error",
        method: "POST",
        body: '{"p_operation":"upload"}',
        headers: { Prefer: "tx=commit" },
      });
    },
  );
  it.each(["{}", "true true", "x".repeat(17), "null"])(
    "consumes malformed response %s without retry",
    async (body) => {
      const transport = vi.fn<typeof fetch>(async () => new Response(body));
      const claim = postgresAttemptClaims({
        session,
        publicKey: "synthetic",
        transport,
        check: () => {},
      });
      await expect(claim(key)).rejects.toThrow();
      await expect(claim(key)).rejects.toThrow("CLAIM_ATTEMPT_USED");
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects rollback acknowledgment, network ambiguity and alternate targets", async () => {
    for (const transport of [
      vi.fn<typeof fetch>(
        async () =>
          new Response("true", {
            headers: { "preference-applied": "tx=rollback" },
          }),
      ),
      vi.fn<typeof fetch>(async () => {
        throw Error("synthetic");
      }),
    ]) {
      const claim = postgresAttemptClaims({
        session,
        publicKey: "synthetic",
        transport,
        check: () => {},
      });
      await expect(claim(key + "-other")).rejects.toThrow(
        "CLAIM_TARGET_DENIED",
      );
      expect(transport).not.toHaveBeenCalled();
      await expect(claim(key)).rejects.toThrow();
      await expect(claim(key)).rejects.toThrow("CLAIM_ATTEMPT_USED");
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
});

describe("claim SQL in disposable embedded PostgreSQL (not Supabase durability proof)", () => {
  it("rolls back all new objects on collision without replacing an existing function", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT null::uuid';
        CREATE FUNCTION public.smart_storage_claim_once(p_operation text) RETURNS boolean LANGUAGE sql AS 'SELECT false';`);
      await expect(
        db.exec(
          await readFile(
            "experiments/storage/disposable-postgres-claims.sql",
            "utf8",
          ),
        ),
      ).rejects.toThrow();
      await db.exec("ROLLBACK");
      expect(
        (
          await db.query(
            "SELECT nspname FROM pg_namespace WHERE nspname='smart_storage_claims'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db.query<{ used: boolean }>(
            "SELECT public.smart_storage_claim_once('upload') AS used",
          )
        ).rows[0].used,
      ).toBe(false);
    } finally {
      await db.close();
    }
  }, 30000);
  it("deploys as a nonsuperuser without role changes or changes to existing schema grants", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
        'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
        CREATE ROLE fixture_deployer LOGIN NOCREATEROLE;
        GRANT CREATE ON DATABASE postgres TO fixture_deployer;
        GRANT USAGE, CREATE ON SCHEMA public TO fixture_deployer WITH GRANT OPTION;
        GRANT USAGE ON SCHEMA auth TO fixture_deployer WITH GRANT OPTION;
        GRANT EXECUTE ON FUNCTION auth.uid() TO fixture_deployer WITH GRANT OPTION;
        SET SESSION AUTHORIZATION fixture_deployer;`);
      const existingGrants = `SELECT n.nspname, a.grantor, a.grantee, a.privilege_type, a.is_grantable
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
        LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname IN ('public', 'auth') AND coalesce(r.rolname, '') <> 'smart_storage_claim_owner'
        ORDER BY 1,2,3,4,5`;
      const before = await db.query(existingGrants);
      const memberships = await db.query(
        "SELECT * FROM pg_auth_members ORDER BY roleid, member, grantor",
      );
      // PGlite's bootstrap postgres cannot be demoted. Substitute only the
      // deployment-role identifier to exercise the same DDL without superuser.
      const sql = (
        await readFile(
          "experiments/storage/disposable-postgres-claims.sql",
          "utf8",
        )
      ).replace(/\bpostgres\b/g, "fixture_deployer");
      await db.exec(sql);
      const after = await db.query(existingGrants);
      expect(after.rows).toEqual(before.rows);
      expect(
        (
          await db.query(
            "SELECT * FROM pg_auth_members ORDER BY roleid, member, grantor",
          )
        ).rows,
      ).toEqual(memberships.rows);
      expect(
        (
          await db.query(
            "SELECT rolname FROM pg_roles WHERE rolname = 'smart_storage_claim_owner'",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  }, 30000);
  it("pins target, fences duplicates and denies ordinary mutation and wrong identity", async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
        'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';`);
      await db.exec(
        await readFile(
          "experiments/storage/disposable-postgres-claims.sql",
          "utf8",
        ),
      );
      const call = (op: string) =>
        db.query<{ used: boolean }>(
          "SELECT public.smart_storage_claim_once($1) AS used",
          [op],
        );
      await db.exec(
        `SET SESSION AUTHORIZATION authenticated; SET request.jwt.claim.sub = '${t.userId}';`,
      );
      await db.exec("BEGIN; SET LOCAL synchronous_commit = off");
      expect((await call("upload")).rows[0].used).toBe(true);
      expect(
        (
          await db.query<{ synchronous_commit: string }>(
            "SHOW synchronous_commit",
          )
        ).rows[0].synchronous_commit,
      ).toBe("on");
      // Explicitly prove the limit: an enclosing rollback erases the claim.
      // The real RPC must be qualified to commit before reporting success.
      await db.exec("ROLLBACK");
      await expect(call("download")).rejects.toThrow("upload claim required");
      await expect(call("reset")).rejects.toThrow("claim denied");
      // PGlite serializes these calls: uniqueness coverage, not a live
      // multi-connection race or provider crash-durability qualification.
      const contenders = await Promise.all(
        Array.from({ length: 8 }, () => call("upload")),
      );
      expect(contenders.filter((result) => result.rows[0].used)).toHaveLength(
        1,
      );
      expect((await call("upload")).rows[0].used).toBe(false);
      expect((await call("download")).rows[0].used).toBe(true);
      for (const sql of [
        "DELETE FROM smart_storage_claims.attempts",
        "TRUNCATE smart_storage_claims.attempts",
        "UPDATE smart_storage_claims.attempts SET operation='upload'",
        "SELECT * FROM smart_storage_claims.attempts",
        "INSERT INTO smart_storage_claims.attempts VALUES ('rrylhvqalsxjnkdkpwde', 'smart-storage-gateway-probe', 'practice-roundtrip/20261019/compressed-test-001.bin', 'upload', now())",
        "SET ROLE smart_storage_claim_owner",
      ]) {
        await expect(db.exec(sql)).rejects.toThrow();
      }
      await db.exec(
        "SET request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001'",
      );
      await expect(call("upload")).rejects.toThrow("claim denied");
      await db.exec(
        "RESET SESSION AUTHORIZATION; SET SESSION AUTHORIZATION anon",
      );
      await expect(call("upload")).rejects.toThrow();
      await db.exec(
        "RESET SESSION AUTHORIZATION; SET SESSION AUTHORIZATION service_role",
      );
      await expect(call("upload")).rejects.toThrow();
      await db.exec("SET SESSION AUTHORIZATION postgres");
      await db.exec("RESET ROLE");
      expect(
        (await db.query<{ current_user: string }>("SELECT current_user"))
          .rows[0].current_user,
      ).toBe("postgres");
      for (const sql of [
        "DELETE FROM smart_storage_claims.attempts",
        "UPDATE smart_storage_claims.attempts SET operation='upload'",
        "TRUNCATE smart_storage_claims.attempts",
      ]) {
        await expect(db.exec(sql)).rejects.toThrow("claims are permanent");
      }
      const count = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM smart_storage_claims.attempts",
      );
      expect(count.rows[0].n).toBe(2);
      await db.exec(
        await readFile(
          "experiments/storage/disposable-postgres-claims.verify.readonly.sql",
          "utf8",
        ),
      );
    } finally {
      await db.close();
    }
  }, 30000);
});
