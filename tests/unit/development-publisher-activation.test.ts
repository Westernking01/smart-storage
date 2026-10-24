import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
vi.mock("server-only", () => ({}));
import { postgresPublisher } from "../../src/lib/backend/development-publisher-postgres.server";

const root = "supabase/development-cloud/";
const read = (path: string) => readFileSync(path, "utf8");
const sql = (file: string): string =>
  read(root + file)
    .replace(/^\\ir (.*)$/gm, (_, child) => sql(child.trim()))
    .replace(/^\\.*$/gm, "");
const owner = "00000000-0000-4000-8000-000000000123";
const other = "00000000-0000-4000-8000-000000000124";

it.each([false, true])(
  "provisions, asserts and rolls back with non-superuser creator=%s",
  async (managedCreator) => {
    const db = new PGlite();
    try {
      if (managedCreator)
        await db.exec(`
      CREATE ROLE fixture_bootstrap SUPERUSER LOGIN;
      SET SESSION AUTHORIZATION fixture_bootstrap;
      ALTER ROLE postgres RENAME TO fixture_catalog_owner;
      CREATE ROLE postgres LOGIN CREATEROLE;
      ALTER DATABASE postgres OWNER TO postgres;
      ALTER SCHEMA public OWNER TO postgres;
      SET SESSION AUTHORIZATION postgres;
    `);
      await db.exec(
        `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$; CREATE SCHEMA storage; CREATE TABLE storage.objects(bucket_id text,name text,owner_id text,metadata jsonb); CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`,
      );
      for (const file of [
        "202610130001_backend_schema.sql",
        "202610130002_control_functions.sql",
        "202610130003_trusted_transitions_and_rls.sql",
      ])
        await db.exec(read("supabase/migrations/" + file));
      await db.exec(read(root + "install.sql"));
      for (const row of JSON.parse(
        read("tests/fixtures/development-cloud-live-auth-baseline.json"),
      ))
        await db.exec(row.definition);
      await db.exec("SET app.settings.project_ref='fneuqneqaopkmpeevlqz'");
      const provision = sql("provision-publisher-login.sql");
      await db.exec("GRANT TEMP ON DATABASE postgres TO PUBLIC");
      // PUBLIC TEMP stays enabled throughout provisioning and rollback.
      await db.exec(
        "REVOKE CREATE ON DATABASE postgres FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      );
      await db.exec(
        "CREATE FUNCTION public.unrelated() RETURNS integer LANGUAGE sql AS $$SELECT 1$$",
      );
      await expect(db.exec(provision)).rejects.toThrow(
        /unrelated routine exposure/,
      );
      await db.exec(
        "ROLLBACK; REVOKE EXECUTE ON FUNCTION public.unrelated() FROM PUBLIC",
      );
      await db.exec(
        "CREATE SCHEMA extensions; CREATE VIEW extensions.pg_stat_statements AS SELECT 1 value; CREATE VIEW extensions.pg_stat_statements_info AS SELECT 1 value; GRANT SELECT ON extensions.pg_stat_statements,extensions.pg_stat_statements_info TO PUBLIC;",
      );
      await db.exec("GRANT USAGE ON SCHEMA extensions TO PUBLIC");
      await expect(db.exec(provision)).rejects.toThrow(
        /relation privilege exposure/,
      );
      await db.exec("ROLLBACK");
      expect(
        (
          await db.query(
            "SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher_login'",
          )
        ).rows,
      ).toEqual([]);
      await db.exec("REVOKE USAGE ON SCHEMA extensions FROM PUBLIC");
      await db.exec(provision);
      for (const test of JSON.parse(
        read("tests/fixtures/publisher-monitoring-privileges.json"),
      )) {
        if (test.admin && managedCreator)
          await db.exec("SET SESSION AUTHORIZATION fixture_bootstrap");
        await db.exec(test.setup);
        if (test.admin && managedCreator)
          await db.exec("SET SESSION AUTHORIZATION postgres");
        await expect(
          db.exec(sql("publisher-permissions.assert.sql")),
        ).rejects.toThrow(new RegExp(test.error));
        if (test.admin && managedCreator)
          await db.exec("SET SESSION AUTHORIZATION fixture_bootstrap");
        await db.exec(test.undo);
        if (test.admin && managedCreator)
          await db.exec("SET SESSION AUTHORIZATION postgres");
        await db.exec(sql("publisher-permissions.assert.sql"));
      }
      const incoming = await db.query(
        "SELECT member::regrole::text member,grantor,admin_option,inherit_option,set_option FROM pg_catalog.pg_auth_members WHERE roleid='ss_dev_cloud_publisher_login'::regrole",
      );
      expect(incoming.rows).toEqual(
        managedCreator
          ? [
              {
                member: "postgres",
                grantor: 10,
                admin_option: true,
                inherit_option: false,
                set_option: false,
              },
            ]
          : [],
      );
      if (managedCreator) {
        for (const option of ["ADMIN FALSE", "INHERIT TRUE", "SET TRUE"]) {
          await db.exec(
            `SET SESSION AUTHORIZATION fixture_bootstrap; GRANT ss_dev_cloud_publisher_login TO postgres WITH ${option} GRANTED BY fixture_catalog_owner; SET SESSION AUTHORIZATION postgres`,
          );
          await expect(
            db.exec(sql("publisher-permissions.assert.sql")),
          ).rejects.toThrow(/membership closure drift/);
          await db.exec(
            "SET SESSION AUTHORIZATION fixture_bootstrap; GRANT ss_dev_cloud_publisher_login TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY fixture_catalog_owner; SET SESSION AUTHORIZATION postgres",
          );
        }
        await db.exec(
          "GRANT ss_dev_cloud_publisher_login TO anon WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
        );
        await expect(
          db.exec(sql("publisher-permissions.assert.sql")),
        ).rejects.toThrow(/membership closure drift/);
        await db.exec("REVOKE ss_dev_cloud_publisher_login FROM anon");
      }
      for (const target of [
        "ss_dev_cloud_publisher_login",
        "ss_dev_cloud_publisher",
      ]) {
        await db.exec(`GRANT TEMP ON DATABASE postgres TO ${target}`);
        await expect(
          db.exec(sql("publisher-permissions.assert.sql")),
        ).rejects.toThrow(/non-PUBLIC TEMP exposure/);
        await db.exec(`REVOKE TEMP ON DATABASE postgres FROM ${target}`);
      }
      await db.exec(
        "GRANT CREATE ON DATABASE postgres TO ss_dev_cloud_publisher_login",
      );
      await expect(
        db.exec(sql("publisher-permissions.assert.sql")),
      ).rejects.toThrow(/database CREATE exposure/);
      await db.exec(
        "REVOKE CREATE ON DATABASE postgres FROM ss_dev_cloud_publisher_login",
      );
      await db.exec(
        "ALTER FUNCTION app_private.dev_cloud_owner() SET search_path=public",
      );
      await expect(
        db.exec(sql("publisher-permissions.assert.sql")),
      ).rejects.toThrow(/helper contract drift/);
      await db.exec(
        "ALTER FUNCTION app_private.dev_cloud_owner() SET search_path=''",
      );
      const membership = await db.query(
        "SELECT admin_option,inherit_option,set_option FROM pg_auth_members WHERE member='ss_dev_cloud_publisher_login'::regrole",
      );
      expect(membership.rows).toEqual([
        { admin_option: false, inherit_option: false, set_option: true },
      ]);
      await db.exec(
        "GRANT SELECT(owner_id) ON public.files TO ss_dev_cloud_publisher_login",
      );
      await expect(
        db.exec(sql("publisher-permissions.assert.sql")),
      ).rejects.toThrow(/relation privilege exposure/);
      await db.exec(
        "REVOKE SELECT(owner_id) ON public.files FROM ss_dev_cloud_publisher_login",
      );
      for (const option of ["ADMIN TRUE", "INHERIT TRUE", "SET FALSE"]) {
        await db.exec(
          `GRANT ss_dev_cloud_publisher TO ss_dev_cloud_publisher_login WITH ${option}`,
        );
        await expect(
          db.exec(sql("publisher-permissions.assert.sql")),
        ).rejects.toThrow(/membership closure drift/);
        await db.exec(
          "GRANT ss_dev_cloud_publisher TO ss_dev_cloud_publisher_login WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
        );
      }
      await db.exec("SET SESSION AUTHORIZATION ss_dev_cloud_publisher_login");
      await expect(db.exec("SET ROLE postgres")).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.exec("SELECT public.unrelated()")).rejects.toThrow(
        /permission denied/,
      );
      await db.exec(
        "CREATE TEMP TABLE files(id int); CREATE TEMP TABLE pg_roles(rolname text)",
      );
      await db.exec(sql("publisher-permissions.assert.sql"));
      await db.exec("SET ROLE ss_dev_cloud_publisher");
      await db.exec(
        "SET search_path=pg_temp,public; CREATE TEMP TABLE dev_cloud_accounts(owner_id uuid,enabled boolean); INSERT INTO dev_cloud_accounts VALUES ('00000000-0000-4000-8000-000000000123',true)",
      );
      for (const call of [
        "ss_begin_attempt_request(NULL,1,NULL,1)",
        "ss_finish_attempt_request(NULL,NULL)",
        "ss_record_observation(NULL,1,1)",
        "ss_finalize_verified(NULL,'{}'::jsonb,1,NULL,NULL)",
      ])
        await expect(db.exec(`SELECT public.${call}`)).rejects.toThrow(
          /DEV_ACCOUNT_DISABLED/,
        );
      await expect(db.exec("SELECT * FROM public.files")).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.exec("SELECT public.ss_list_files()")).rejects.toThrow(
        /permission denied/,
      );
      await db.query(
        "SELECT set_config('request.jwt.claim',$1,false),set_config('request.jwt.claim.sub',$2,false),set_config('request.jwt.claims',$1,false)",
        [JSON.stringify({ sub: other, role: "authenticated" }), other],
      );
      await db.exec("DISCARD ALL");
      expect(
        (
          await db.query(
            "SELECT current_user, nullif(current_setting('request.jwt.claim',true),'') claim, nullif(current_setting('request.jwt.claim.sub',true),'') sub, nullif(current_setting('request.jwt.claims',true),'') claims",
          )
        ).rows,
      ).toEqual([
        {
          current_user: "ss_dev_cloud_publisher_login",
          claim: null,
          sub: null,
          claims: null,
        },
      ]);
      // Exercise the real adapter transaction/reset SQL. Replace only the final
      // publication invocation with context inspection; never publish here.
      const release = vi.fn();
      const verify = vi.fn(async () => owner);
      const query = async (text: string, values?: unknown[]) => {
        if (text.startsWith("SELECT public.ss_finish_attempt_request(")) {
          const context = await db.query(
            "SELECT current_user,session_user,current_setting('request.jwt.claims',true)::jsonb claims,nullif(current_setting('request.jwt.claim',true),'') legacy",
          );
          expect(context.rows).toEqual([
            {
              current_user: "ss_dev_cloud_publisher",
              session_user: "ss_dev_cloud_publisher_login",
              claims: {
                sub: await verify(),
                role: "ss_dev_cloud_publisher",
                is_anonymous: false,
              },
              legacy: null,
            },
          ]);
          return { rows: [{ result: null }] };
        }
        return db.query(text, values);
      };
      const adapter = postgresPublisher(
        { connect: async () => ({ query, release }) } as unknown as Pick<
          Pool,
          "connect"
        >,
        verify,
      );
      for (const subject of [owner, other]) {
        verify.mockResolvedValue(subject);
        await db.exec(
          "SET ROLE ss_dev_cloud_publisher; SET request.jwt.claim='{}'; SET request.jwt.claims='{}'",
        );
        await adapter.trusted("ss_finish_attempt_request", {
          p_request: owner,
          p_offset: null,
        });
        expect(
          (
            await db.query(
              "SELECT current_user,nullif(current_setting('request.jwt.claims',true),'') claims",
            )
          ).rows,
        ).toEqual([
          { current_user: "ss_dev_cloud_publisher_login", claims: null },
        ]);
      }
      expect(release.mock.calls).toEqual([[false], [false]]);
      // No backend TLS in this fixture, as with a TLS-terminating pooler hop.
      // Poison session state to prove DISCARD ALL and transaction-local reset.
      await db.exec(
        "SET ROLE ss_dev_cloud_publisher; SET request.jwt.claims='{}'",
      );
      // psql sends DISCARD ALL separately, outside the following SQL batch.
      await db.exec("DISCARD ALL");
      await db.exec(
        sql("publisher-preflight.readonly.sql").replace("DISCARD ALL;", ""),
      );
      expect(
        (
          await db.query(
            "SELECT current_user,session_user,nullif(current_setting('request.jwt.claims',true),'') claims",
          )
        ).rows,
      ).toEqual([
        {
          current_user: "ss_dev_cloud_publisher_login",
          session_user: "ss_dev_cloud_publisher_login",
          claims: null,
        },
      ]);
      // psql sends DISCARD ALL separately, outside the following SQL batch.
      await db.exec("DISCARD ALL");
      await db.exec(
        sql("publisher-preflight.readonly.sql").replace("DISCARD ALL;", ""),
      );
      await db.exec("ROLLBACK");
      await db.exec(
        "SET SESSION AUTHORIZATION postgres; RESET ROLE; SET app.settings.project_ref='fneuqneqaopkmpeevlqz'",
      );
      expect(
        (
          await db.query(
            "SELECT session_user,current_user,current_setting('app.settings.project_ref',true) pin",
          )
        ).rows,
      ).toEqual([
        {
          session_user: "postgres",
          current_user: "postgres",
          pin: "fneuqneqaopkmpeevlqz",
        },
      ]);
      await db.exec(sql("rollback-publisher-login.sql"));
      expect(
        (
          await db.query(
            "SELECT rolname FROM pg_roles WHERE rolname='ss_dev_cloud_publisher_login'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db.query(
            "SELECT rolname FROM pg_roles WHERE rolname='ss_dev_cloud_publisher'",
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await db.close();
    }
  },
  30000,
);

it("resets a reused connection and binds each verified owner locally; destroys on identity change", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ sql: text, values });
    return {
      rows: [
        text.includes("session_user")
          ? { login: "ss_dev_cloud_publisher_login" }
          : { result: null },
      ],
    };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const verify = vi.fn(async () => owner);
  const adapter = postgresPublisher(
    { connect } as unknown as Pick<Pool, "connect">,
    verify,
  );
  const args = { p_request: owner, p_offset: null };
  await adapter.trusted("ss_finish_attempt_request", args);
  verify.mockResolvedValue(other);
  await adapter.trusted("ss_finish_attempt_request", args);
  expect(calls.filter((c) => c.sql === "DISCARD ALL")).toHaveLength(2);
  expect(
    calls
      .filter((c) => c.sql.includes("set_config"))
      .map((c) => JSON.parse(c.values![0] as string).sub),
  ).toEqual([owner, other]);
  expect(release.mock.calls).toEqual([[false], [false]]);
  verify.mockResolvedValueOnce(owner).mockResolvedValueOnce(other);
  await expect(
    adapter.trusted("ss_finish_attempt_request", args),
  ).rejects.toThrow("CLOUD_TRUSTED_RPC_UNAVAILABLE");
  expect(release).toHaveBeenLastCalledWith(true);
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
});

it.each(["missing", "expired-before-checkout", "expired-after-checkout"])(
  "rejects %s identity before any RPC",
  async (failure) => {
    const query = vi.fn<(sql: string) => Promise<{ rows: unknown[] }>>(
      async () => ({ rows: [] }),
    );
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const verify = vi.fn<() => Promise<string>>();
    if (failure === "missing") verify.mockResolvedValue("");
    else if (failure === "expired-before-checkout")
      verify.mockRejectedValue(Error("EXPIRED_SESSION"));
    else
      verify
        .mockResolvedValueOnce(owner)
        .mockRejectedValueOnce(Error("EXPIRED_SESSION"));
    const adapter = postgresPublisher(
      { connect } as unknown as Pick<Pool, "connect">,
      verify,
    );
    await expect(
      adapter.trusted("ss_finish_attempt_request", {
        p_request: owner,
        p_offset: null,
      }),
    ).rejects.toThrow();
    expect(
      query.mock.calls.some(([q]) => String(q).includes("SELECT public.")),
    ).toBe(false);
    if (failure !== "expired-after-checkout")
      expect(connect).not.toHaveBeenCalled();
    else expect(release).toHaveBeenLastCalledWith(true);
  },
);
