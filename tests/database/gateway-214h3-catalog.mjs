import { spawnSync } from "node:child_process";
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
env.PGCONNECT_TIMEOUT = "3";
export function run(sql, expected) {
  const r = spawnSync(
    "C:/Program Files/PostgreSQL/17/bin/psql.exe",
    [
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
      "smart_storage_gateway_test",
    ],
    { env, input: sql, encoding: "utf8", timeout: 15000 },
  );
  if (expected) {
    if (r.status === 0 || !r.stderr.includes(expected))
      throw Error(r.stderr || "expected rejection");
    return;
  }
  if (r.error || r.status !== 0) throw Error(r.error?.message ?? r.stderr);
  return r.stdout.trim();
}
console.log(
  run(
    `begin read only; select current_database(),inet_server_addr(),inet_server_port(); select rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin from pg_roles order by rolname; select pg_get_userbyid(roleid),pg_get_userbyid(member),inherit_option,set_option from pg_auth_members; select datname,datacl from pg_database; select nspname,nspacl from pg_namespace where nspname in ('public','app_private'); select c.relname,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relname like 'gateway%'; rollback;`,
  ),
);
