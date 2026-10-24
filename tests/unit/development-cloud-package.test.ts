import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
const read = (name: string) =>
  readFileSync(`supabase/development-cloud/${name}`, "utf8");
describe("development cloud offline deployment boundaries", () => {
  it("generates a reproducible standalone transaction without SQL execution", () => {
    const before = read("install.sql");
    const correction = read("correct-aliases.sql");
    const rollback = read("rollback-aliases.sql");
    execFileSync(process.execPath, ["scripts/prepare-dev-cloud-package.mjs"]);
    expect(read("install.sql")).toBe(before);
    expect(read("correct-aliases.sql")).toBe(correction);
    expect(read("rollback-aliases.sql")).toBe(rollback);
    expect(before).toContain("Predecessor mismatch");
    expect(before).toContain("Contract drift");
    expect(before.trim().endsWith("COMMIT;")).toBe(true);
  });
  it("changes only conflicting variable identifiers and preserves the fifth RPC", () => {
    const old = readFileSync(
      "tests/fixtures/development-cloud-pre-alias-install.sql",
      "utf8",
    ).replaceAll("\r\n", "\n");
    const corrected = read("install.sql");
    const variables: Record<string, string> = {
      v_actor: "a",
      v_session: "s",
      v_file: "f",
      v_block: "b",
      v_attempt: "a",
      v_request: "r",
      v_usage: "u",
      v_descriptor: "d",
    };
    for (const name of [
      "ss_allocate_attempt",
      "ss_begin_attempt_request",
      "ss_finish_attempt_request",
      "ss_record_observation",
      "ss_finalize_verified",
    ]) {
      const pattern = new RegExp(
        `create or replace function public\\.${name}\\(.*?end \\$\\$;`,
        "s",
      );
      const previous = old.match(pattern)![0];
      const next = corrected.match(pattern)![0];
      expect(
        next.replace(
          /'(?:''|[^'])*'|\b[a-z_]+\b/g,
          (token) => variables[token] ?? token,
        ),
      ).toBe(previous);
      if (name === "ss_begin_attempt_request") expect(next).toBe(previous);
    }
    for (const file of ["correct-aliases.sql", "rollback-aliases.sql"]) {
      const sql = read(file);
      expect(sql.match(/^CREATE OR REPLACE FUNCTION public\./gm)).toHaveLength(
        4,
      );
      expect(sql).toContain("pg_get_functiondef(p) IS DISTINCT FROM");
      expect(sql).toContain("backup drift");
      expect(sql).not.toMatch(
        /CREATE ROLE|GRANT |REVOKE |CREATE TABLE|DROP |CREATE POLICY/,
      );
    }
  });
  it("requires enrollment and quota binding before granting allocation authority", () => {
    const allocation = read("install.sql")
      .split("create or replace function public.ss_allocate_attempt")[1]
      .split("end $$;")[0];
    expect(allocation.indexOf("DEV_QUOTA_BINDING")).toBeLessThan(
      allocation.indexOf("'storageAuthorityEnabled',true"),
    );
    expect(allocation).toContain("perform app_private.dev_cloud_owner()");
    expect(allocation).toContain("if number>1");
    expect(allocation).toContain("AMBIGUOUS_ATTEMPT_LOCKED");
  });
  it("requires actual object metadata and acknowledged bytes for publication evidence", () => {
    const sql = read("install.sql");
    expect(sql).toContain("DEV_BLOCK_OBJECT_REQUIRED");
    expect(sql).toContain(
      "a.acknowledged_bytes=p_size AND a.attempted_bytes=p_size",
    );
    expect(sql).toContain("DEV_MANIFEST_OBJECT_REQUIRED");
    expect(sql).toContain("BLOCK_EVIDENCE_INVALID");
    expect(sql.match(/DEV_PUBLISHER_REQUIRED/g)).toHaveLength(4);
    expect(sql).toContain("a.owner_id=app_private.dev_cloud_owner()");
  });
  it("scopes Storage by owner, exact path and request state without update/delete", () => {
    const sql = read("policies.sql");
    expect(sql).toContain("owner_id=auth.uid()::text");
    expect(sql).toContain("a.object_path=p_name");
    expect(sql).toContain("r.state='reserved'");
    expect(sql).not.toMatch(/FOR (UPDATE|DELETE|ALL)/);
    expect(sql).toContain("s.lease_expires_at>now()");
  });
  it("keeps publisher restricted and enrollment explicit", () => {
    const sql = read("install.sql");
    expect(sql).toContain(
      "NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    expect(
      sql.match(
        /GRANT EXECUTE ON FUNCTION public\.ss_.* TO ss_dev_cloud_publisher/g,
      ),
    ).toHaveLength(4);
    expect(sql).not.toMatch(
      /GRANT (SELECT|INSERT|UPDATE|DELETE|ALL).*TO ss_dev_cloud_publisher/,
    );
    expect(read("enroll-account.sql")).toContain(
      "Verified ordinary subject UUID",
    );
    expect(read("enroll-account.sql")).toContain(
      "Existing usage requires separate review",
    );
  });
  it("rolls back authority while retaining cloud objects and accounting", () => {
    const sql = read("rollback.sql");
    expect(sql).toContain("SET enabled=false");
    expect(sql).toContain("EXECUTE r.definition");
    expect(sql).not.toMatch(/DELETE FROM|DROP TABLE|DROP ROLE/);
    expect(sql).toContain("REVOKE ss_dev_cloud_publisher FROM authenticator");
  });
});
