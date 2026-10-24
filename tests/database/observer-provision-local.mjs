// Local administrator is used for provisioning/catalog only; never runtime evidence.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
env.PGCONNECT_TIMEOUT = "3";
function sql(input) {
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
    { env, input, encoding: "utf8", timeout: 15000 },
  );
  if (r.error || r.status !== 0) throw Error(r.error?.message ?? r.stderr);
  return r.stdout.trim();
}
const check = (q) =>
  assert.equal(sql(`begin read only; select ${q}; rollback;`), "t");
check(
  "current_database()='smart_storage_gateway_test' and current_setting('server_version')='17.11' and inet_server_addr()='127.0.0.1'::inet and inet_server_port()=5432 and current_user='postgres'",
);
check(
  "not exists(select from pg_roles where rolname='ss_gateway_observer_runtime_test') and exists(select from pg_roles where rolname='ss_gateway_observer' and not(rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) and not exists(select from pg_auth_members where roleid='ss_gateway_observer'::regrole or member='ss_gateway_observer'::regrole) and not exists(select from pg_shdepend where refclassid='pg_authid'::regclass and refobjid='ss_gateway_observer'::regrole and deptype='o')",
);
check(
  "not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind in ('r','p','v','m','S','f') and has_table_privilege('ss_gateway_observer',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))",
);
check(
  "has_function_privilege('ss_gateway_observer','public.ss_gateway_record_receipt_v1(uuid,uuid,uuid,bigint,jsonb)','EXECUTE') and not has_function_privilege('ss_gateway_observer','public.ss_gateway_resolve_dispatch_v1(uuid,uuid,uuid,uuid,bigint,bigint)','EXECUTE')",
);
check(
  "exists(select from pg_proc where oid='public.ss_gateway_record_receipt_v1(uuid,uuid,uuid,bigint,jsonb)'::regprocedure and proowner='postgres'::regrole and prosecdef and proconfig @> array['search_path=\"\"'])",
);
check(
  "not exists(select from pg_database d cross join lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a where d.datname='smart_storage_gateway_test' and a.grantee=0 and a.privilege_type in ('CONNECT','TEMPORARY'))",
);
check("not exists(select from pg_hba_file_rules where error is not null)");
const hba = sql("show hba_file;");
assert.equal(
  hba.replaceAll("\\", "/"),
  "C:/Program Files/PostgreSQL/17/data/pg_hba.conf",
);
const original = readFileSync(hba);
assert(!original.toString().includes("ss_gateway_observer_runtime_test"));
const catalog = JSON.parse(
  sql(
    `select json_build_object('databaseAcls',(select json_agg(json_build_object('name',datname,'owner',pg_get_userbyid(datdba),'acl',datacl)) from pg_database),'memberships',(select json_agg(json_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option)) from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member),'hba',(select json_agg(row_to_json(r) order by rule_number) from (select rule_number,type,database,user_name,address,auth_method,error from pg_hba_file_rules) r));`,
  ),
);
writeFileSync(
  "tests/database/observer-preflight.json",
  JSON.stringify(catalog, null, 2) + "\n",
);
const active = original
  .toString()
  .split(/\r?\n/)
  .map((x) => x.trim())
  .filter((x) => x && !x.startsWith("#"));
// Pin the previously approved executor rules and preserved original defaults.
assert.deepEqual(
  active.map((x) => x.split(/\s+/).join(" ")),
  [
    "host smart_storage_gateway_test ss_gateway_runtime_test 127.0.0.1/32 scram-sha-256",
    "host all ss_gateway_runtime_test 0.0.0.0/0 reject",
    "host all ss_gateway_runtime_test ::0/0 reject",
    "local all ss_gateway_runtime_test reject",
    "local all all scram-sha-256",
    "host all all 127.0.0.1/32 scram-sha-256",
    "host all all ::1/128 scram-sha-256",
    "local replication all scram-sha-256",
    "host replication all 127.0.0.1/32 scram-sha-256",
    "host replication all ::1/128 scram-sha-256",
  ],
);
const proposal = readFileSync(
  "tests/database/observer-runtime-proposal.sql",
  "utf8",
);
assert.equal((proposal.match(/ROLLBACK;/g) ?? []).length, 1);
if (process.argv[2] !== "--execute") {
  console.log(
    "PASS exact local target, role collision/graph/ownership/private ACL/definer/database ACL/HBA preflight; no mutations",
  );
  process.exit(0);
}
const backup = `C:/ProgramData/SmartStoragePgTest/pg_hba.pre-observer-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.bak`;
copyFileSync(hba, backup, 1);
assert.deepEqual(readFileSync(backup), original);
const rules =
  "# Smart Storage dedicated observer runtime\r\nhost smart_storage_gateway_test ss_gateway_observer_runtime_test 127.0.0.1/32 scram-sha-256\r\nhost all ss_gateway_observer_runtime_test 0.0.0.0/0 reject\r\nhost all ss_gateway_observer_runtime_test ::0/0 reject\r\nlocal all ss_gateway_observer_runtime_test reject\r\n";
writeFileSync(hba, Buffer.concat([Buffer.from(rules), original]));
check("not exists(select from pg_hba_file_rules where error is not null)");
assert.equal(sql("select pg_reload_conf();"), "t");
sql(proposal.replace("ROLLBACK;", "COMMIT;"));
check(
  "exists(select from pg_roles where rolname='ss_gateway_observer_runtime_test' and rolcanlogin and not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) and (select count(*)=1 from pg_auth_members where member='ss_gateway_observer_runtime_test'::regrole) and exists(select from pg_auth_members where member='ss_gateway_observer_runtime_test'::regrole and roleid='ss_gateway_observer'::regrole and not admin_option and not inherit_option and set_option)",
);
check(
  "not has_database_privilege('ss_gateway_observer_runtime_test','smart_storage_gateway_test','TEMP') and has_database_privilege('ss_gateway_observer_runtime_test','smart_storage_gateway_test','CONNECT')",
);
writeFileSync(
  "tests/database/observer-provisioning.json",
  JSON.stringify(
    {
      status: "PROVISIONED_PASSWORD_PENDING",
      at: new Date().toISOString(),
      target: "127.0.0.1:5432/smart_storage_gateway_test",
      role: "ss_gateway_observer_runtime_test",
      proposalSha256: createHash("sha256").update(proposal).digest("hex"),
      backup,
      originalHbaSha256: createHash("sha256").update(original).digest("hex"),
      addedRules: rules.split("\r\n").filter(Boolean),
      membership: {
        role: "ss_gateway_observer",
        admin: false,
        inherit: false,
        set: true,
      },
      databaseChange: "CONNECT grant only; existing PUBLIC ACL unchanged",
      password: "UNSET; interactive user provisioning required",
      cleanup:
        "Separately authorize exact role/membership/CONNECT/search_path/HBA removal after dependency and session review; no database reset",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS observer provisioned; existing administrator reconnect successful; password remains unset",
);
