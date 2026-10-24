import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const enrollmentSql = (file: string): string =>
  readFileSync("supabase/development-cloud/" + file, "utf8")
    .replace(/^\\ir (.*)$/gm, (_, child: string) => enrollmentSql(child.trim()))
    .replace(/^\\.*$/gm, "");

type Database = {
  exec: (sql: string) => Promise<unknown>;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};
const subject = "00000000-0000-4000-8000-000000000123";
const other = "00000000-0000-4000-8000-000000000124";
const claims = (sub = subject) =>
  JSON.stringify({ sub, role: "ss_dev_cloud_publisher", is_anonymous: false });

/** Disposable fixture only. Never accepts a connection URL or contacts Supabase. */
export async function enrollmentChecks(
  db: Database,
  nativePreflight?: () => Promise<void>,
) {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,role text,email_confirmed_at timestamptz,deleted_at timestamptz,is_anonymous boolean);
    CREATE SCHEMA storage;
    CREATE TABLE storage.objects(bucket_id text,name text,owner_id text,metadata jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for (const row of JSON.parse(
    readFileSync(
      "tests/fixtures/development-cloud-live-auth-baseline.json",
      "utf8",
    ),
  ))
    if (row.nspname === "auth") await db.exec(row.definition);
  for (const file of [
    "202610130001_backend_schema.sql",
    "202610130002_control_functions.sql",
    "202610130003_trusted_transitions_and_rls.sql",
  ])
    await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
  await db.exec(enrollmentSql("install.sql"));
  for (const row of JSON.parse(
    readFileSync(
      "tests/fixtures/development-cloud-live-auth-baseline.json",
      "utf8",
    ),
  ))
    await db.exec(row.definition);
  await db.exec(
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE CREATE ON DATABASE postgres FROM PUBLIC; SET app.settings.project_ref='fneuqneqaopkmpeevlqz'",
  );
  await db.exec(enrollmentSql("provision-publisher-login.sql"));
  await assert.rejects(
    db.exec(enrollmentSql("publisher-enrollment-permissions.assert.sql")),
  );
  await db.exec("SET app.settings.project_ref='wrong'");
  await assert.rejects(
    db.exec(enrollmentSql("install-enrollment.sql")),
    /Verified project owner/,
  );
  await db.exec(
    "ROLLBACK; SET app.settings.project_ref='fneuqneqaopkmpeevlqz'; CREATE ROLE fixture_extra; ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO fixture_extra",
  );
  await assert.rejects(
    db.exec(enrollmentSql("install-enrollment.sql")),
    /Enrollment ACL drift/,
  );
  await db.exec(
    "ROLLBACK; ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM fixture_extra",
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT to_regprocedure('public.ss_dev_cloud_enrolled()') AS function",
      )
    ).rows,
    [{ function: null }],
  );
  await db.exec(enrollmentSql("install-enrollment.sql"));
  await assert.rejects(
    db.exec(enrollmentSql("publisher-permissions.assert.sql")),
    /unrelated routine/,
  );
  await assert.rejects(db.exec(enrollmentSql("install-enrollment.sql")));
  await db.exec("ROLLBACK");
  await db.exec(`INSERT INTO auth.users VALUES ('${subject}','authenticated',now(),NULL,false),('${other}','authenticated',now(),NULL,false);
    INSERT INTO app_private.dev_cloud_accounts VALUES('${subject}',true)`);

  const probe = async (
    raw: string,
    expected: boolean,
    options: {
      login?: string;
      role?: string;
      readOnly?: boolean;
      legacy?: string;
    } = {},
  ) => {
    await db.exec(
      `SET SESSION AUTHORIZATION ${options.login ?? "ss_dev_cloud_publisher_login"}`,
    );
    try {
      await db.exec(
        `BEGIN ${options.readOnly === false ? "" : "READ ONLY"}; SET LOCAL ROLE ${options.role ?? "ss_dev_cloud_publisher"}`,
      );
      await db.query(
        "SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim',$2,true)",
        [raw, options.legacy ?? ""],
      );
      assert.deepEqual(
        (await db.query("SELECT public.ss_dev_cloud_enrolled() AS enrolled"))
          .rows,
        [{ enrolled: expected }],
      );
    } finally {
      await db.exec("ROLLBACK; SET SESSION AUTHORIZATION postgres");
    }
    assert.deepEqual(
      (
        await db.query(
          "SELECT current_user, nullif(current_setting('request.jwt.claims',true),'') AS claims",
        )
      ).rows,
      [{ current_user: "postgres", claims: null }],
    );
  };
  await probe(claims(), true);
  await probe(claims(other), false);
  await probe(claims(), true); // A/B/A reused connection isolation
  await probe(claims(), false, { readOnly: false });
  await probe(claims(), false, { login: "authenticator" });
  await probe(claims(), false, { role: "postgres", login: "postgres" });
  for (const raw of [
    "",
    "{",
    "null",
    "[]",
    "{}",
    claims("invalid"),
    JSON.stringify({
      sub: subject,
      role: "authenticated",
      is_anonymous: false,
    }),
    JSON.stringify({
      sub: subject,
      role: "ss_dev_cloud_publisher",
      is_anonymous: true,
    }),
    JSON.stringify({ sub: subject, role: "ss_dev_cloud_publisher" }),
    JSON.stringify({ ...JSON.parse(claims()), extra: true }),
  ])
    await probe(raw, false);
  await probe(claims(), false, { legacy: claims(other) });
  for (const [change, undo] of [
    [
      "UPDATE app_private.dev_cloud_accounts SET enabled=false",
      "UPDATE app_private.dev_cloud_accounts SET enabled=true",
    ],
    [
      "UPDATE auth.users SET is_anonymous=true",
      "UPDATE auth.users SET is_anonymous=false",
    ],
    [
      "UPDATE auth.users SET deleted_at=now()",
      "UPDATE auth.users SET deleted_at=NULL",
    ],
    [
      "UPDATE auth.users SET email_confirmed_at=NULL",
      "UPDATE auth.users SET email_confirmed_at=now()",
    ],
    [
      "UPDATE auth.users SET role='service_role'",
      "UPDATE auth.users SET role='authenticated'",
    ],
  ]) {
    await db.exec(change);
    await probe(claims(), false);
    await db.exec(undo);
  }
  // Poison temp namespaces while relation/function references stay qualified.
  await db.exec(
    "SET SESSION AUTHORIZATION ss_dev_cloud_publisher_login; CREATE TEMP TABLE dev_cloud_accounts(owner_id uuid,enabled boolean); SET search_path=pg_temp,public; SET SESSION AUTHORIZATION postgres",
  );
  await probe(claims(), true);
  await db.exec("SET SESSION AUTHORIZATION ss_dev_cloud_publisher_login");
  for (const sql of [
    "SELECT public.ss_dev_cloud_enrolled()",
    "SELECT * FROM app_private.dev_cloud_accounts",
    "SELECT app_private.dev_cloud_owner()",
  ])
    await assert.rejects(db.exec(sql), /permission denied/);
  await db.exec("SET ROLE ss_dev_cloud_publisher");
  await assert.rejects(
    db.exec("SELECT * FROM app_private.dev_cloud_accounts"),
    /permission denied/,
  );
  await assert.rejects(
    db.exec("SELECT app_private.dev_cloud_owner()"),
    /permission denied/,
  );
  await db.exec("SET SESSION AUTHORIZATION postgres");
  // Unexpected grants, metadata/body changes and overloads must block rollback too.
  for (const [tamper, undo] of [
    [
      "GRANT EXECUTE ON FUNCTION public.ss_dev_cloud_enrolled() TO PUBLIC",
      "REVOKE EXECUTE ON FUNCTION public.ss_dev_cloud_enrolled() FROM PUBLIC",
    ],
    [
      "GRANT EXECUTE ON FUNCTION public.ss_dev_cloud_enrolled() TO authenticated",
      "REVOKE EXECUTE ON FUNCTION public.ss_dev_cloud_enrolled() FROM authenticated",
    ],
    [
      "GRANT EXECUTE ON FUNCTION public.ss_dev_cloud_enrolled() TO ss_dev_cloud_publisher WITH GRANT OPTION",
      "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.ss_dev_cloud_enrolled() FROM ss_dev_cloud_publisher",
    ],
    [
      "ALTER FUNCTION public.ss_dev_cloud_enrolled() VOLATILE",
      "ALTER FUNCTION public.ss_dev_cloud_enrolled() STABLE",
    ],
    [
      "ALTER FUNCTION public.ss_dev_cloud_enrolled() SET search_path=public",
      "ALTER FUNCTION public.ss_dev_cloud_enrolled() SET search_path=''",
    ],
    [
      "CREATE FUNCTION public.ss_dev_cloud_enrolled(integer) RETURNS boolean LANGUAGE sql AS $$SELECT false$$",
      "DROP FUNCTION public.ss_dev_cloud_enrolled(integer)",
    ],
    [
      "GRANT SELECT(owner_id) ON app_private.dev_cloud_accounts TO ss_dev_cloud_publisher",
      "REVOKE SELECT(owner_id) ON app_private.dev_cloud_accounts FROM ss_dev_cloud_publisher",
    ],
  ]) {
    await db.exec(tamper);
    await assert.rejects(
      db.exec(enrollmentSql("publisher-enrollment-permissions.assert.sql")),
    );
    await assert.rejects(db.exec(enrollmentSql("rollback-enrollment.sql")));
    await db.exec("ROLLBACK");
    await db.exec(undo);
    await db.exec(enrollmentSql("publisher-enrollment-permissions.assert.sql"));
  }
  const definition = (
    await db.query(
      "SELECT pg_get_functiondef('public.ss_dev_cloud_enrolled()'::regprocedure) AS definition",
    )
  ).rows as { definition: string }[];
  await db.exec(definition[0].definition.replace("e.enabled", "NOT e.enabled"));
  await assert.rejects(
    db.exec(enrollmentSql("publisher-enrollment-permissions.assert.sql")),
    /contract drift/,
  );
  await db.exec(definition[0].definition);
  await db.exec(
    "CREATE VIEW public.fixture_enrollment_dependency AS SELECT public.ss_dev_cloud_enrolled() AS enrolled; REVOKE ALL ON public.fixture_enrollment_dependency FROM PUBLIC",
  );
  await assert.rejects(
    db.exec(enrollmentSql("rollback-enrollment.sql")),
    /depend/,
  );
  await db.exec("ROLLBACK; DROP VIEW public.fixture_enrollment_dependency");
  // Original synthetic preflight under the explicit enrollment assertion version.
  if (nativePreflight) await nativePreflight();
  else {
    await db.exec("DISCARD ALL");
    // Embedded engine has no LOGIN handshake; simulate the authenticated login
    // after DISCARD ALL resets session authorization to the fixture bootstrap.
    await db.exec("SET SESSION AUTHORIZATION ss_dev_cloud_publisher_login");
    await db.exec(
      enrollmentSql("publisher-enrollment-preflight.readonly.sql").replace(
        "DISCARD ALL;",
        "",
      ),
    );
  }
  await db.exec(
    "SET SESSION AUTHORIZATION postgres; SET app.settings.project_ref='fneuqneqaopkmpeevlqz'",
  );
  // Remove hostile fixture temp objects before testing LOGIN removal. Native
  // preflight used a different connection, so its DISCARD did not clear these.
  await db.exec("DISCARD ALL");
  await db.exec(
    "SET SESSION AUTHORIZATION postgres; SET app.settings.project_ref='fneuqneqaopkmpeevlqz'",
  );
  await db.exec(enrollmentSql("rollback-enrollment.sql"));
  await db.exec(enrollmentSql("publisher-permissions.assert.sql"));
  assert.deepEqual(
    (
      await db.query(
        "SELECT to_regprocedure('public.ss_dev_cloud_enrolled()') AS function",
      )
    ).rows,
    [{ function: null }],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM app_private.dev_cloud_accounts",
      )
    ).rows,
    [{ count: 1 }],
  );
  await db.exec(enrollmentSql("rollback-publisher-login.sql"));
}
