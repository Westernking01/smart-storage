import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
vi.mock("server-only", () => ({}));
import {
  postgresPublisher,
  publisherPoolConfig,
} from "../../src/lib/backend/development-publisher-postgres.server";

const owner = "00000000-0000-4000-8000-000000000123";
const other = "00000000-0000-4000-8000-000000000124";
const connection =
  "postgresql://ss_dev_cloud_publisher_login:fixture@db.fneuqneqaopkmpeevlqz.supabase.co:5432/postgres";
it("pins direct host/login, TLS and bounded pool; rejects SSL overrides and admin connections", () => {
  expect(publisherPoolConfig(connection)).toMatchObject({
    max: 2,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  for (const raw of [
    connection + "?sslmode=disable",
    connection.replace("publisher_login", "admin"),
    connection.replace("db.fneuqneqaopkmpeevlqz", "db.other"),
    connection.replace(":5432", ":6543"),
  ])
    expect(() => publisherPoolConfig(raw)).toThrow();
});

const pooler =
  "postgresql://ss_dev_cloud_publisher_login.fneuqneqaopkmpeevlqz:fixture@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
it("accepts only the pinned Session Pooler pair with strict client TLS", () => {
  expect(publisherPoolConfig(pooler)).toMatchObject({
    host: "aws-0-eu-west-1.pooler.supabase.com",
    port: 5432,
    user: "ss_dev_cloud_publisher_login.fneuqneqaopkmpeevlqz",
    database: "postgres",
    ssl: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: "aws-0-eu-west-1.pooler.supabase.com",
    },
    max: 2,
  });
  expect(publisherPoolConfig(pooler)).not.toHaveProperty("connectionString");
  expect(publisherPoolConfig(connection)).toMatchObject({
    ssl: { servername: "db.fneuqneqaopkmpeevlqz.supabase.co" },
  });
});
it.each([
  pooler.replace(":5432", ":6543"),
  pooler.replace("aws-0-eu-west-1", "aws-1-eu-west-1"),
  pooler.replace("fneuqneqaopkmpeevlqz:", "other:"),
  pooler.replace("publisher_login.fneuqneqaopkmpeevlqz", "publisher_login"),
  pooler.replace("publisher_login", "admin"),
  pooler.replace(
    "aws-0-eu-west-1.pooler.supabase.com",
    "db.fneuqneqaopkmpeevlqz.supabase.co",
  ),
  pooler.replace("/postgres", "/other"),
  pooler.replace("postgresql:", "postgres:"),
  pooler.replace(":fixture@", ":@"),
  pooler.replace(":fixture@", ":%zz@"),
  ...[
    "sslmode=disable",
    "sslmode=require",
    "sslmode=verify-full",
    "sslrootcert=untrusted",
    "sslcert=fixture",
    "sslkey=fixture",
    "options=-c%20role=postgres",
  ].map((q) => pooler + "?" + q),
  pooler + "#ignored",
])(
  "rejects unsafe pooler configuration without echoing credentials (%#)",
  (raw) => {
    expect(() => publisherPoolConfig(raw)).toThrow(
      /^DEV_PUBLISHER_CONNECTION_INVALID$/,
    );
  },
);

it.each([false, true])(
  "corrects installed SQL and finalizes under restricted role (allocation ACL variant=%s)",
  async (deployedAcl) => {
    const db = new PGlite();
    const read = (path: string) => readFileSync(path, "utf8");
    try {
      await db.exec(`
      SET plpgsql.variable_conflict='error';
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE authenticator;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY, role text, email_confirmed_at timestamptz, deleted_at timestamptz, is_anonymous boolean);
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(bucket_id text,name text,owner_id text,metadata jsonb);
      ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY; ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    `);
      for (const file of [
        "202610130001_backend_schema.sql",
        "202610130002_control_functions.sql",
        "202610130003_trusted_transitions_and_rls.sql",
      ])
        await db.exec(read(`supabase/migrations/${file}`));
      if (deployedAcl)
        await db.exec(
          "GRANT EXECUTE ON FUNCTION public.ss_allocate_attempt(uuid,integer,bigint,bigint,text,text,text) TO service_role",
        );
      await db.exec(
        read("tests/fixtures/development-cloud-pre-alias-install.sql"),
      );
      const live = JSON.parse(
        read("tests/fixtures/development-cloud-live-alias-baseline.json"),
      );
      for (const row of live.functions) {
        await db.exec(row.definition);
        await db.query(
          "UPDATE app_private.dev_cloud_backup SET definition=$1,installed_hash=$2 WHERE name=$3",
          [row.backup_definition, row.installed_hash, row.name],
        );
      }
      for (const row of JSON.parse(
        read("tests/fixtures/development-cloud-live-auth-baseline.json"),
      ))
        await db.exec(row.definition);
      await db.exec("SET app.settings.project_ref='fneuqneqaopkmpeevlqz'");
      const definitions = () =>
        db.query<{ proname: string; definition: string; acl: string }>(
          "SELECT proname,pg_get_functiondef(oid) definition,proacl::text acl FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('ss_allocate_attempt','ss_begin_attempt_request','ss_finish_attempt_request','ss_record_observation','ss_finalize_verified') ORDER BY proname",
        );
      const before = (await definitions()).rows;
      for (const row of live.functions)
        expect(
          before.find((item) => item.proname === row.name)?.definition,
        ).toBe(row.definition);
      const correction = read("supabase/development-cloud/correct-aliases.sql");
      const signature =
        "public.ss_finalize_verified(uuid,jsonb,bigint,text,text)";
      for (const [tamper, restore, error] of [
        [
          "SET app.settings.project_ref='wrong'",
          "SET app.settings.project_ref='fneuqneqaopkmpeevlqz'",
          "Verified project pin required",
        ],
        [
          `GRANT EXECUTE ON FUNCTION ${signature} TO anon`,
          `REVOKE EXECUTE ON FUNCTION ${signature} FROM anon`,
          "definition/privilege drift",
        ],
        [
          `ALTER FUNCTION ${signature} COST 200`,
          `ALTER FUNCTION ${signature} COST 100`,
          "definition/privilege drift",
        ],
        [
          "UPDATE app_private.dev_cloud_backup SET installed_hash='drift' WHERE name='ss_finalize_verified'",
          "UPDATE app_private.dev_cloud_backup SET installed_hash=(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ss_finalize_verified(uuid,jsonb,bigint,text,text)'::regprocedure) WHERE name='ss_finalize_verified'",
          "backup drift",
        ],
      ]) {
        await db.exec(tamper);
        const drifted = (await definitions()).rows;
        await expect(db.exec(correction)).rejects.toThrow(error);
        await db.exec("ROLLBACK");
        expect((await definitions()).rows).toEqual(drifted);
        await db.exec(restore);
      }
      expect((await definitions()).rows).toEqual(before);
      await db.exec(correction);
      const corrected = (await definitions()).rows;
      expect(corrected.map((row) => row.acl)).toEqual(
        before.map((row) => row.acl),
      );
      expect(
        corrected.find((row) => row.proname === "ss_begin_attempt_request"),
      ).toEqual(
        before.find((row) => row.proname === "ss_begin_attempt_request"),
      );
      await expect(db.exec(correction)).rejects.toThrow(
        "definition/privilege drift",
      );
      await db.exec("ROLLBACK");
      expect((await definitions()).rows).toEqual(corrected);
      await db.exec(read("supabase/development-cloud/rollback-aliases.sql"));
      expect((await definitions()).rows).toEqual(before);
      await db.exec(read("supabase/development-cloud/correct-aliases.sql"));
      await db.exec(`CREATE ROLE ss_dev_cloud_publisher_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      GRANT ss_dev_cloud_publisher TO ss_dev_cloud_publisher_login;
      INSERT INTO auth.users VALUES('${owner}','authenticated',now(),NULL,false),('${other}','authenticated',now(),NULL,false);
      INSERT INTO app_private.dev_cloud_accounts VALUES('${owner}',true);`);
      await db.exec(
        read("supabase/development-cloud/enroll-account.sql")
          .split(/\r?\n/)
          .filter((line) => !line.startsWith("\\"))
          .join("\n")
          .replace(":'subject'", `'${owner}'`),
      );
      const claims = async (sub: string, role: string) => {
        await db.query("SELECT set_config('request.jwt.claims',$1,false)", [
          JSON.stringify({ sub, role }),
        ]);
      };
      await claims(owner, "authenticated");
      const key = "00000000-0000-4000-8000-000000000125";
      await db.query(
        "SELECT public.ss_reserve($1,'fixture','application/octet-stream',10,$2)",
        [key, "a".repeat(64)],
      );
      const session = (
        await db.query<{ id: string }>("SELECT id FROM public.upload_sessions")
      ).rows[0].id;
      const allocation = (
        await db.query<{ value: { id: string; path: string } }>(
          "SELECT public.ss_allocate_attempt($1,0,10,10,'raw',$2,$2) value",
          [session, "a".repeat(64)],
        )
      ).rows[0].value;
      await expect(
        db.query("SELECT public.ss_allocate_attempt($1,0,10,11,'raw',$2,$2)", [
          session,
          "a".repeat(64),
        ]),
      ).rejects.toThrow("DEV_BLOCK_LIMIT");
      await expect(
        db.query("SELECT public.ss_allocate_attempt($1,0,11,11,'raw',$2,$2)", [
          session,
          "a".repeat(64),
        ]),
      ).rejects.toThrow("DEV_QUOTA_BINDING");
      await expect(
        db.query("SELECT public.ss_allocate_attempt($1,0,10,10,'raw',$2,$2)", [
          session,
          "a".repeat(64),
        ]),
      ).rejects.toThrow("AMBIGUOUS_ATTEMPT_LOCKED");
      await db.exec(
        "RESET request.jwt.claims; SET ROLE ss_dev_cloud_publisher_login",
      );
      await expect(
        db.exec("UPDATE public.files SET state='ready'"),
      ).rejects.toThrow(/permission denied/);
      await db.exec("SET ROLE ss_dev_cloud_publisher");

      await db.exec("SET search_path=pg_temp,public,auth,app_private");
      for (const name of [
        "files",
        "upload_sessions",
        "user_usage",
        "transfer_attempts",
        "file_blocks",
        "file_manifests",
        "usage_events",
        "attempt_requests",
        "dev_cloud_accounts",
        "objects",
      ]) {
        await db.exec(`CREATE TEMP TABLE ${name}(poison text)`);
      }
      const request = "00000000-0000-4000-8000-000000000126";
      const begin = () =>
        db.query("SELECT public.ss_begin_attempt_request($1,1,$2,10)", [
          allocation.id,
          request,
        ]);
      await expect(begin()).rejects.toThrow(/DEV_ACCOUNT_DISABLED/);
      await claims(owner, "authenticated");
      await expect(begin()).rejects.toThrow(/DEV_PUBLISHER_REQUIRED/);
      await claims(other, "ss_dev_cloud_publisher");
      await expect(begin()).rejects.toThrow(/DEV_ACCOUNT_DISABLED/);
      await db.exec("RESET ROLE");
      await db.exec(
        `UPDATE app_private.dev_cloud_accounts SET enabled=true WHERE owner_id='${other}'; INSERT INTO app_private.dev_cloud_accounts VALUES('${other}',true) ON CONFLICT DO NOTHING;`,
      );
      await db.exec("SET ROLE ss_dev_cloud_publisher");
      await expect(begin()).rejects.toThrow(/DEV_OWNER/);
      await db.query(
        "SELECT set_config('request.jwt.claim',$1,false),set_config('request.jwt.claim.sub',$2,false)",
        [JSON.stringify({ sub: other, role: "authenticated" }), other],
      );
      await db.exec("RESET request.jwt.claims; BEGIN");
      await db.query(
        "SELECT set_config('request.jwt.claim','',true),set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({ sub: owner, role: "ss_dev_cloud_publisher" })],
      );
      await begin();
      await db.exec("COMMIT");
      expect(
        (
          await db.query(
            "SELECT current_setting('request.jwt.claims',true) claims",
          )
        ).rows,
      ).toEqual([{ claims: "" }]);
      await expect(begin()).rejects.toThrow(/DEV_PUBLISHER_REQUIRED/);
      await db.exec("RESET request.jwt.claim; RESET request.jwt.claim.sub");
      await expect(begin()).rejects.toThrow(/DEV_ACCOUNT_DISABLED/);
      await claims(owner, "ss_dev_cloud_publisher");
      await expect(begin()).rejects.toThrow(
        "REQUEST_REPLAY_REQUIRES_INSPECTION",
      );
      await db.exec("BEGIN");
      await db.query("SELECT public.ss_finish_attempt_request($1,NULL)", [
        request,
      ]);
      await db.exec("RESET ROLE");
      expect(
        (
          await db.query(
            "SELECT s.state,a.state attempt,u.reserved_bytes>0 held,u.active_slots FROM public.upload_sessions s JOIN public.transfer_attempts a ON a.session_id=s.id JOIN public.user_usage u ON u.owner_id=s.owner_id",
          )
        ).rows,
      ).toEqual([
        {
          state: "reconciling",
          attempt: "ambiguous",
          held: true,
          active_slots: 1,
        },
      ]);
      await db.exec("ROLLBACK");
      await db.query("SELECT public.ss_finish_attempt_request($1,10)", [
        request,
      ]);
      await expect(
        db.query("SELECT public.ss_record_observation($1,1,10)", [
          allocation.id,
        ]),
      ).rejects.toThrow("DEV_BLOCK_OBJECT_REQUIRED");
      await db.exec("RESET ROLE");
      await db.query(
        "INSERT INTO storage.objects VALUES('smart-storage-dev-cloud',$1,$2,'{\"size\":10}')",
        [allocation.path, owner],
      );
      await db.exec("SET ROLE ss_dev_cloud_publisher");
      await db.query("SELECT public.ss_record_observation($1,1,10)", [
        allocation.id,
      ]);
      const manifest = {
        format: "compression-spike",
        version: 1,
        blockSize: 8388608,
        originalBytes: 10,
        originalSha256: "a".repeat(64),
        blocks: [
          {
            index: 0,
            offset: 0,
            originalBytes: 10,
            encodedBytes: 10,
            codec: "raw",
            originalSha256: "a".repeat(64),
            encodedSha256: "a".repeat(64),
          },
        ],
      };
      await db.exec("RESET ROLE");
      const path = (
        await db.query<{ manifest_path: string }>(
          "SELECT manifest_path FROM public.upload_sessions",
        )
      ).rows[0].manifest_path;
      await db.exec("SET ROLE ss_dev_cloud_publisher");
      const finalize = (candidate: unknown = manifest) =>
        db.query<{ value: { state: string } }>(
          "SELECT public.ss_finalize_verified($1,$2,1000,$3,$4) value",
          [session, candidate, "b".repeat(64), path],
        );
      await expect(finalize()).rejects.toThrow("DEV_MANIFEST_OBJECT_REQUIRED");
      await db.exec("RESET ROLE");
      await db.query(
        "INSERT INTO storage.objects VALUES('smart-storage-dev-cloud',$1,$2,'{\"size\":1000}')",
        [path, owner],
      );
      await db.exec("SET ROLE ss_dev_cloud_publisher");
      await claims(other, "ss_dev_cloud_publisher");
      await expect(finalize()).rejects.toThrow("DEV_MANIFEST_OBJECT_REQUIRED");
      await expect(
        db.query("SELECT public.ss_finish_attempt_request($1,10)", [request]),
      ).rejects.toThrow("DEV_OWNER");
      await expect(
        db.query("SELECT public.ss_record_observation($1,1,10)", [
          allocation.id,
        ]),
      ).rejects.toThrow("DEV_OWNER");
      await claims(owner, "ss_dev_cloud_publisher");
      await expect(
        finalize({ ...manifest, originalSha256: "c".repeat(64) }),
      ).rejects.toThrow("MANIFEST_INVALID");
      await expect(
        finalize({
          ...manifest,
          blocks: [{ ...manifest.blocks[0], encodedSha256: "c".repeat(64) }],
        }),
      ).rejects.toThrow("BLOCK_EVIDENCE_INVALID");
      await db.exec("RESET ROLE");
      expect(
        (
          await db.query(
            "SELECT state,held_bytes>0 held,slot_held FROM public.upload_sessions",
          )
        ).rows,
      ).toEqual([{ state: "uploading", held: true, slot_held: true }]);
      expect(
        (await db.query("SELECT count(*)::int n FROM public.file_manifests"))
          .rows,
      ).toEqual([{ n: 0 }]);
      await db.exec("SET ROLE ss_dev_cloud_publisher");
      expect((await finalize()).rows[0].value).toMatchObject({
        state: "ready",
      });
      await finalize(); // Idempotent success must not settle accounting twice.
      await db.exec("RESET ROLE");
      expect(
        (
          await db.query(
            "SELECT stored_bytes::text,active_slots FROM public.user_usage WHERE owner_id=$1",
            [owner],
          )
        ).rows,
      ).toEqual([{ stored_bytes: "1010", active_slots: 0 }]);
      expect(
        (
          await db.query(
            "SELECT reserved_bytes::text,historical_original_bytes::text,historical_stored_bytes::text FROM public.user_usage WHERE owner_id=$1",
            [owner],
          )
        ).rows,
      ).toEqual([
        {
          reserved_bytes: "0",
          historical_original_bytes: "10",
          historical_stored_bytes: "1010",
        },
      ]);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM public.usage_events WHERE kind='commit'",
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      await claims(owner, "authenticated");
      await db.exec("SET ROLE authenticated");
      expect(
        (
          await db.query<{ value: { state: string }[] }>(
            "SELECT public.ss_list_files() value",
          )
        ).rows[0].value,
      ).toEqual([expect.objectContaining({ state: "ready" })]);
      await claims(other, "authenticated");
      expect(
        (
          await db.query<{ value: unknown }>(
            "SELECT public.ss_list_files() value",
          )
        ).rows[0].value,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  },
  30000,
);

it("verifies every operation before checkout; rolls back and destroys uncertain connections", async () => {
  const query = vi.fn(async (sql: string) =>
    sql.includes("session_user")
      ? { rows: [{ login: "ss_dev_cloud_publisher_login" }] }
      : { rows: [{ result: null }] },
  );
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const verify = vi.fn(async () => owner);
  const authority = postgresPublisher(
    { connect } as unknown as Pick<Pool, "connect">,
    verify,
  );
  const args = { p_request: owner, p_offset: null };
  await authority.trusted("ss_finish_attempt_request", args);
  expect(release).toHaveBeenLastCalledWith(false);
  expect(
    query.mock.calls.find(([sql]) => sql.includes("set_config"))?.[0],
  ).toContain("true");
  expect(
    query.mock.calls.find(([sql]) => sql.includes("set_config"))?.[0],
  ).toContain("set_config('request.jwt.claim', '', true)");
  verify.mockRejectedValueOnce(Error("EXPIRED_SESSION"));
  await expect(
    authority.trusted("ss_finish_attempt_request", args),
  ).rejects.toThrow("EXPIRED_SESSION");
  expect(connect).toHaveBeenCalledTimes(1);
  query.mockRejectedValueOnce(Error("connection lost"));
  await expect(
    authority.trusted("ss_finish_attempt_request", args),
  ).rejects.toThrow("CLOUD_TRUSTED_RPC_UNAVAILABLE");
  expect(release).toHaveBeenLastCalledWith(true);
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  await expect(
    authority.trusted("ss_finalize_verified; DROP TABLE files", {}),
  ).rejects.toThrow();
});
