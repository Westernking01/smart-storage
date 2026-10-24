// Explicit Phase 2.14E target only. Never reads credentials or application env.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const psql = "C:/Program Files/PostgreSQL/17/bin/psql.exe";
const database = "smart_storage_gateway_test";
if (existsSync("tests/database/gateway-214e-results.json")) {
  throw new Error(
    "Retained Phase 2.14E evidence exists; bootstrap cannot overwrite or replay it",
  );
}
const roles = [
  "anon",
  "authenticated",
  "service_role",
  "ss_gateway_executor",
  "ss_gateway_observer",
  "ss_gateway_finalizer",
  "ss_gateway_cleaner",
];
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
env.PGCONNECT_TIMEOUT = "3";
const args = (db) => [
  "-X",
  "-w",
  "-qAt",
  "-v",
  "ON_ERROR_STOP=1",
  "-h",
  "127.0.0.1",
  "-p",
  "5432",
  "-U",
  "postgres",
  "-d",
  db,
];
const sql = (input, db = database) => {
  const r = spawnSync(psql, args(db), {
    input,
    env,
    encoding: "utf8",
    timeout: 20000,
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr);
  return r.stdout.trim();
};
const evidence = {
  phase: "2.14E",
  database,
  createdRoles: [],
  migrations: [],
  assertions: [],
  status: "PARTIAL",
};
const save = () =>
  writeFileSync(
    "tests/database/gateway-214e-results.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
try {
  const preflight = JSON.parse(
    sql(
      `select json_build_object('version',current_setting('server_version'),'database',current_database(),'target_exists',exists(select from pg_database where datname='${database}'),'roles',(select coalesce(json_agg(rolname),'[]') from pg_roles where rolname in (${roles.map((r) => `'${r}'`).join(",")})),'plpgsql',exists(select from pg_extension where extname='plpgsql'),'uuid',to_regprocedure('pg_catalog.gen_random_uuid()') is not null,'sha256',to_regprocedure('pg_catalog.sha256(bytea)') is not null);`,
      "postgres",
    ),
  );
  evidence.preflight = preflight;
  if (
    preflight.target_exists ||
    preflight.roles.length ||
    !preflight.plpgsql ||
    !preflight.uuid ||
    !preflight.sha256
  )
    throw new Error(
      "Preflight collision or missing prerequisite; no bootstrap allowed",
    );
  const names = [
    "202610130001_backend_schema.sql",
    "202610130002_control_functions.sql",
    "202610130003_trusted_transitions_and_rls.sql",
    "202610160004_gateway_claim_contracts.sql",
    "202610160005_gateway_provider_evidence.sql",
    "202610160006_gateway_preparation_cleanup.sql",
    "202610160007_gateway_lifecycle.sql",
  ];
  const sources = names.map((n) =>
    readFileSync(`supabase/migrations/${n}`, "utf8"),
  );
  const roleSQL = sources.flatMap((s) =>
    [...s.matchAll(/create role [^;]+;/gi)].map((m) => m[0].toLowerCase()),
  );
  if (
    JSON.stringify(roleSQL) !==
      JSON.stringify(
        roles.slice(3).map((r) => `create role ${r} nologin noinherit;`),
      ) ||
    sources.some((s) =>
      /alter role|create extension|grant\s+\w+\s+to\s+\w+\s*;/i.test(s),
    )
  )
    throw new Error("Unexpected role/extension SQL; review required");
  sql(
    `create database ${database} encoding 'UTF8' template template0;`,
    "postgres",
  );
  evidence.databaseCreated = true;
  save();
  sql(
    roles
      .slice(0, 3)
      .map(
        (r) =>
          `create role ${r} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;`,
      )
      .join("\n"),
  );
  evidence.createdRoles.push(...roles.slice(0, 3));
  save();
  sql(`create schema auth;
create table auth.users(id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
revoke all on all functions in schema auth from public,anon;
grant usage on schema auth to authenticated;
grant execute on all functions in schema auth to authenticated;`);
  for (let i = 0; i < names.length; i++) {
    sql(sources[i]);
    evidence.migrations.push(names[i]);
    evidence.createdRoles.push(
      ...[...sources[i].matchAll(/create role (\w+)/gi)].map((m) => m[1]),
    );
    save();
    console.log(`PASS migration ${names[i]}`);
  }
  evidence.roleAttributes = JSON.parse(
    sql(
      `select json_agg(json_build_object('name',rolname,'login',rolcanlogin,'inherit',rolinherit,'superuser',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls)) from pg_roles where rolname in (${roles.map((r) => `'${r}'`).join(",")});`,
    ),
  );
  if (
    evidence.roleAttributes.some((r) =>
      Object.entries(r).some(([k, v]) => k !== "name" && v),
    )
  )
    throw new Error("Unexpected elevated role attribute");
  sql(readFileSync("tests/database/gateway-claims-fixture.sql", "utf8"));
  for (const file of [
    "gateway-evidence-contract.sql",
    "gateway-finalization-cleanup-contract.sql",
    "gateway-lifecycle-contract.sql",
  ]) {
    sql(readFileSync(`tests/database/${file}`, "utf8"));
    evidence.assertions.push(file);
    save();
    console.log(`PASS serial ${file}`);
  }
} catch (error) {
  evidence.failure = error.message;
  evidence.status = "BLOCKED";
  save();
  throw error;
} finally {
  save();
}
