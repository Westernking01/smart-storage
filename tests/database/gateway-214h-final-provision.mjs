// Approved local-only provisioning. Never reads or assigns any password.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import assert from "node:assert/strict";
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
env.PGCONNECT_TIMEOUT = "3";
function run(sql) {
  const result = spawnSync(
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
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
const check = (sql) =>
  assert.equal(run(`begin read only; select ${sql}; rollback;`), "t");
check(
  "current_database()='smart_storage_gateway_test' and current_setting('server_version')='17.11' and inet_server_addr()='127.0.0.1'::inet and inet_server_port()=5432 and current_user='postgres'",
);
const inventory = JSON.parse(
  readFileSync("tests/database/gateway-214e-inventory.json", "utf8"),
);
assert.equal(
  JSON.parse(readFileSync("tests/database/gateway-214e-results.json", "utf8"))
    .migrations.length,
  7,
);
for (const phase of ["214h1", "214h3"])
  assert.equal(
    JSON.parse(
      readFileSync(`tests/database/gateway-${phase}-results.json`, "utf8"),
    ).status,
    "COMPLETE",
  );
check(
  inventory.relations
    .map((x) => `to_regclass('${x.schema}.${x.name}') is not null`)
    .concat(
      inventory.functions.map(
        (x) => `to_regprocedure('${x.signature}') is not null`,
      ),
      [
        "to_regprocedure('public.ss_gateway_record_write_observation_v1(uuid,uuid,uuid,uuid,bigint,uuid,jsonb)') is not null",
        "to_regprocedure('public.ss_gateway_resolve_dispatch_v1(uuid,uuid,uuid,uuid,bigint,bigint)') is not null",
      ],
    )
    .join(" and "),
);
check(
  "not exists(select from pg_roles where rolname='ss_gateway_runtime_test') and exists(select from pg_roles where rolname='ss_gateway_executor' and not (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) and not exists(select from pg_auth_members where roleid='ss_gateway_executor'::regrole or member='ss_gateway_executor'::regrole) and not exists(select from pg_shdepend where refclassid='pg_authid'::regclass and refobjid='ss_gateway_executor'::regrole and deptype='o')",
);
check(
  "not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and has_table_privilege('ss_gateway_executor',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))",
);
check(
  "not exists(select from pg_database where datdba<>'postgres'::regrole) and (select datacl is null from pg_database where datname='smart_storage_gateway_test') and not exists(select from pg_stat_activity where datname='smart_storage_gateway_test' and usename is distinct from 'postgres')",
);
const hba = run("show hba_file;");
assert.equal(
  hba.replaceAll("\\", "/"),
  "C:/Program Files/PostgreSQL/17/data/pg_hba.conf",
);
const original = readFileSync(hba);
const text = original.toString("utf8");
const active = text
  .split(/\r?\n/)
  .map((x) => x.trim())
  .filter((x) => x && !x.startsWith("#"));
assert.deepEqual(
  active.map((x) => x.split(/\s+/).join(" ")),
  [
    "local all all scram-sha-256",
    "host all all 127.0.0.1/32 scram-sha-256",
    "host all all ::1/128 scram-sha-256",
    "local replication all scram-sha-256",
    "host replication all 127.0.0.1/32 scram-sha-256",
    "host replication all ::1/128 scram-sha-256",
  ],
);
check("not exists(select from pg_hba_file_rules where error is not null)");
assert.equal(process.argv[2], "--execute");
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const backup = `C:/ProgramData/SmartStoragePgTest/pg_hba.pre-214h-final-${stamp}.bak`;
copyFileSync(hba, backup, 1);
assert.deepEqual(readFileSync(backup), original);
const rules =
  "# Smart Storage Phase 2.14H restricted runtime\r\nhost smart_storage_gateway_test ss_gateway_runtime_test 127.0.0.1/32 scram-sha-256\r\nhost all ss_gateway_runtime_test 0.0.0.0/0 reject\r\nhost all ss_gateway_runtime_test ::0/0 reject\r\nlocal all ss_gateway_runtime_test reject\r\n";
// Install isolation before creating a login. Preserve every original byte.
writeFileSync(hba, Buffer.concat([Buffer.from(rules), original]));
check("not exists(select from pg_hba_file_rules where error is not null)");
assert.equal(run("select pg_reload_conf();"), "t");
run(`begin;
create role ss_gateway_runtime_test login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit;
grant ss_gateway_executor to ss_gateway_runtime_test with admin false, inherit false, set true;
revoke connect,temporary on database smart_storage_gateway_test from public;
grant connect on database smart_storage_gateway_test to ss_gateway_runtime_test;
alter role ss_gateway_runtime_test in database smart_storage_gateway_test set search_path='';
commit;`);
const effective = run(
  "select json_agg(row_to_json(r) order by rule_number) from (select rule_number,type,database,user_name,address,auth_method,error from pg_hba_file_rules) r;",
);
writeFileSync(
  "tests/database/gateway-214h-final-provisioning.json",
  JSON.stringify(
    {
      phase: "2.14H FINAL",
      provisionedAt: new Date().toISOString(),
      target: "127.0.0.1:5432/smart_storage_gateway_test",
      role: "ss_gateway_runtime_test",
      password: "UNSET: user interactive psql password required",
      backup,
      addedHbaRules: rules.split("\r\n").filter(Boolean),
      membership: {
        role: "ss_gateway_executor",
        admin: false,
        inherit: false,
        set: true,
      },
      databaseAcl:
        "PUBLIC CONNECT/TEMP revoked; runtime CONNECT granted; postgres owner remains",
      roleSetting: "search_path='' on target only",
      effectiveFileRules: JSON.parse(effective),
      cleanup:
        "Separate authorization: remove exact added HBA lines/reload; disable/drop new login after dependency/session review; revoke new membership/CONNECT/settings; restore reviewed original PUBLIC ACL. Preserve all historical fixtures.",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS local preflight, external HBA backup, role-only HBA isolation/reload, restricted role/membership and target ACL provisioning. Password remains unset.",
);
