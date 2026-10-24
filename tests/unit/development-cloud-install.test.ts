import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each([false, true])(
  "installs, enrolls and rolls back with deployed allocation ACL variant=%s",
  async (deployedAcl) => {
    const db = new PGlite();
    const read = (p: string) => readFileSync(p, "utf8");
    try {
      await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS; CREATE ROLE authenticator;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, role text, email_confirmed_at timestamptz, deleted_at timestamptz, is_anonymous boolean);
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(bucket_id text,name text,owner_id text,metadata jsonb);
      ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO authenticated;
      GRANT SELECT ON storage.buckets TO authenticated;
      GRANT SELECT,INSERT ON storage.objects TO authenticated;
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
      const originals = (
        await db.query(
          "SELECT proname,prosrc,proacl::text acl FROM pg_proc WHERE proname IN ('ss_allocate_attempt','ss_begin_attempt_request','ss_finish_attempt_request','ss_record_observation','ss_finalize_verified') ORDER BY proname",
        )
      ).rows;
      await db.exec("SET app.settings.project_ref='fneuqneqaopkmpeevlqz'");
      await db.exec(read("supabase/development-cloud/install.sql"));
      await db.exec(read("supabase/development-cloud/install.sql"));
      const subject = "00000000-0000-4000-8000-000000000123";
      await db.exec(
        `INSERT INTO auth.users VALUES('${subject}','authenticated',now(),NULL,false);`,
      );
      const enrollment = read("supabase/development-cloud/enroll-account.sql")
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("\\"))
        .join("\n")
        .replace(":'subject'", `'${subject}'`);
      await db.exec(enrollment);
      expect(
        (
          await db.query(
            "SELECT stored_bytes::text,reserved_bytes::text,active_slots,quota_bytes::text,max_slots FROM public.user_usage",
          )
        ).rows,
      ).toEqual([
        {
          stored_bytes: "0",
          reserved_bytes: "0",
          active_slots: 0,
          quota_bytes: "6422528",
          max_slots: 1,
        },
      ]);
      await db.exec(read("supabase/development-cloud/rollback.sql"));
      expect(
        (
          await db.query(
            "SELECT proname,prosrc,proacl::text acl FROM pg_proc WHERE proname IN ('ss_allocate_attempt','ss_begin_attempt_request','ss_finish_attempt_request','ss_record_observation','ss_finalize_verified') ORDER BY proname",
          )
        ).rows,
      ).toEqual(originals);
      expect(
        (await db.query("SELECT enabled FROM app_private.dev_cloud_accounts"))
          .rows,
      ).toEqual([{ enabled: false }]);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM pg_policies WHERE schemaname='storage'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await db.close();
    }
  },
  30000,
);
