// Exact local target only. Credential content is never read by this script.
// --interactive: psql alone prompts privately. --passfile uses an external path.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const exe = "C:/Program Files/PostgreSQL/17/bin/psql.exe";
const role = "ss_gateway_observer_runtime_test";
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
env.PGCONNECT_TIMEOUT = "3";
const args = (user, db = "smart_storage_gateway_test", host = "127.0.0.1") => [
  "-X",
  "-qAt",
  "-v",
  "ON_ERROR_STOP=1",
  "-h",
  host,
  "-p",
  "5432",
  "-U",
  user,
  "-d",
  db,
];
function admin(sql) {
  const r = spawnSync(exe, [...args("postgres"), "-w"], {
    env: {
      ...env,
      PGPASSFILE: "C:/ProgramData/SmartStoragePgTest/pgpass.conf",
    },
    input: sql,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(r.status, 0, "LOCAL_ADMIN_QUERY_FAILED");
  return r.stdout.trim();
}
assert.equal(
  admin(
    "select current_user='postgres' and current_database()='smart_storage_gateway_test' and current_setting('server_version')='17.11' and inet_server_addr()='127.0.0.1'::inet and inet_server_port()=5432;",
  ),
  "t",
);
const catalog = JSON.parse(
  admin(
    `select json_build_object('role',(select json_build_object('login',rolcanlogin,'safe',not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) from pg_roles where rolname='${role}'),'memberships',(select count(*) from pg_auth_members where member='${role}'::regrole),'membershipSafe',exists(select from pg_auth_members where member='${role}'::regrole and roleid='ss_gateway_observer'::regrole and not admin_option and not inherit_option and set_option),'privateDenied',not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and has_table_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),'hba',(select json_agg(row_to_json(r) order by rule_number) from (select rule_number,type,database,user_name,address,auth_method,error from pg_hba_file_rules) r));`,
  ),
);
assert.deepEqual(catalog.role, { login: true, safe: true });
assert.equal(catalog.memberships, 1);
assert(catalog.membershipSafe && catalog.privateDenied);
assert(catalog.hba.every((x) => !x.error));
writeFileSync(
  "tests/database/observer-post-provision-catalog.json",
  JSON.stringify(catalog, null, 2) + "\n",
);
// Wrong database and IPv6 must fail at HBA, before any password is used.
for (const [db, host] of [
  ["postgres", "127.0.0.1"],
  ["template1", "127.0.0.1"],
  ["smart_storage_gateway_test", "::1"],
]) {
  const r = spawnSync(exe, [...args(role, db, host), "-w", "-c", "select 1"], {
    env: { ...env, PGPASSFILE: "NUL" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pg_hba.conf rejects connection/);
}
if (process.argv[2] === "--catalog-only") {
  console.log(
    "PASS catalog and independent HBA negative connections; no observer authentication attempted",
  );
  process.exit(0);
}
assert(
  ["--interactive", "--passfile"].includes(process.argv[2]),
  "SELECT_EXPLICIT_AUTHENTICATION_MODE",
);
const passfile = process.argv[2] === "--passfile" ? process.argv[3] : undefined;
if (passfile) {
  assert(
    !passfile.toLowerCase().replaceAll("\\", "/").includes("/smart-storage/"),
    "EXTERNAL_PASSFILE_REQUIRED",
  );
  env.PGPASSFILE = passfile;
} else env.PGPASSFILE = "NUL";
const namespace = randomUUID().slice(0, 8);
const id = (p, k = 1) =>
  `${p}${namespace.slice(1)}-214b-4000-8000-${String(k).padStart(12, "0")}`;
let fixture = readFileSync(
  "tests/database/gateway-claims-fixture.sql",
  "utf8",
).replace(/([0-9a-d])0000000-0000-0000-0000-/g, (_, p) => id(p).slice(0, 24));
for (const [table, p] of [
  ["auth.users", "0"],
  ["public.files", "1"],
  ["public.upload_sessions", "2"],
  ["public.file_blocks", "3"],
])
  fixture = fixture.replaceAll(
    `from ${table};`,
    `from ${table} where id::text like '${id(p).slice(0, 24)}%';`,
  );
const scope =
  '{"namespace":"local-observer-' +
  namespace +
  '","uploadId":null,"version":null,"generation":null}';
const payload = JSON.stringify({
  scope: JSON.parse(scope),
  kind: "inspection",
  outcome: "ambiguous",
  observedAt: "2026-10-16T00:00:00Z",
  observedBytes: 8,
  provenance: { source: "local-observer-test" },
  verifierRevision: "local-observer-v1",
});
const receipt = (op, owner = id("0"), epoch = 1, body = payload) =>
  `public.ss_gateway_record_receipt_v1('${owner}','${id("7")}','${op}',${epoch},'${body}'::jsonb)`;
const expectError = (statement, token) =>
  `DO $test$ BEGIN BEGIN ${statement}; EXCEPTION WHEN OTHERS THEN IF position('${token}' in SQLERRM)>0 THEN RETURN; END IF; RAISE; END; RAISE EXCEPTION 'EXPECTED_DENIAL'; END $test$;`;
const path = `v1/${id("0")}/${id("1")}/${id("2")}/1/0/${id("4")}.bin`;
const inventory = {
  namespace,
  state: "planned",
  ownerIds: [id("0"), id("0", 2)],
  sessionIds: [1, 2, 3, 4].map((k) => id("2", k)),
  requestId: id("5"),
  resourceId: id("7"),
  operationId: id("8"),
};
const inventoryFile = `tests/database/observer-fixture-${namespace}.json`;
writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2) + "\n");
admin(`begin; ${fixture} set local role ss_gateway_executor;
select public.ss_gateway_claim_v1('${id("0")}','${id("4")}','${id("5")}',8,'${id("6")}');
select public.ss_gateway_register_resource_v1('${id("0")}','${id("5")}','${id("7")}',1,'object','${path}','${scope}',8); commit;`);
inventory.state = "fixture-committed";
writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2) + "\n");
const runtime = `DO $$ BEGIN ASSERT session_user='${role}' AND current_user=session_user AND current_database()='smart_storage_gateway_test' AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432; END $$;
${expectError("SELECT " + receipt(id("8")), "permission denied")}
${expectError("SELECT * FROM app_private.gateway_observation_receipts", "permission denied")}
${expectError("CREATE TEMP TABLE forbidden_observer_temp(x int)", "permission denied")}
${expectError("SET ROLE ss_gateway_executor", "permission denied")}
${expectError("SET ROLE postgres", "permission denied")}
${expectError("CREATE ROLE forbidden_observer_role", "permission denied")}
BEGIN; SET LOCAL ROLE ss_gateway_observer;
DO $$ BEGIN ASSERT current_user='ss_gateway_observer'; END $$;
${expectError("SELECT * FROM app_private.gateway_observation_receipts", "permission denied")}
DO $$ BEGIN ASSERT ${receipt(id("8"))}=${receipt(id("8"))}; END $$;
${expectError("SELECT " + receipt(id("8"), id("0"), 1, payload.replace('"observedBytes":8', '"observedBytes":9')), "IDEMPOTENCY_CONFLICT")}
${expectError("SELECT " + receipt(id("8", 2), id("0", 2)), "FORBIDDEN")}
${expectError("SELECT " + receipt(id("8", 2), id("0"), 2), "STALE_EPOCH")}
COMMIT;
DO $$ BEGIN ASSERT current_user=session_user; END $$;
BEGIN; SET LOCAL ROLE ss_gateway_observer; ROLLBACK;
DO $$ BEGIN ASSERT current_user=session_user; END $$;
SELECT 'PASS independent observer authentication, switching/reset, receipt commit and negative privileges';`;
const runtimeFile = `tests/database/observer-runtime-${namespace}.sql`;
writeFileSync(runtimeFile, runtime);
const interactive = process.argv[2] === "--interactive";
const r = spawnSync(
  exe,
  [...args(role), interactive ? "-W" : "-w", "-f", runtimeFile],
  {
    env,
    encoding: "utf8",
    stdio: interactive ? "inherit" : "pipe",
    timeout: interactive ? 300000 : 30000,
  },
);
if (r.status !== 0) {
  inventory.state = "runtime-failed-retained";
  writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2) + "\n");
  throw Error("OBSERVER_RUNTIME_VALIDATION_FAILED_NO_RETRY");
}
assert.equal(
  admin(
    `select (select count(*)=1 and bool_and(issuer='ss_gateway_observer') and bool_and(sufficiency='provisional') from app_private.gateway_observation_receipts where owner_id='${id("0")}') and (select reserved_bytes=262160 and active_slots=2 and stored_bytes=0 from public.user_usage where owner_id='${id("0")}') and (select held_bytes=131080 and slot_held and state='uploading' from public.upload_sessions where id='${id("2")}') and (select slot_held from app_private.gateway_requests where request_id='${id("5")}');`,
  ),
  "t",
);
inventory.state = "verified-retained";
writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2) + "\n");
writeFileSync(
  "tests/database/observer-runtime-results.json",
  JSON.stringify(
    {
      status: "PASS",
      at: new Date().toISOString(),
      namespace,
      independentObserverAuthentication: true,
      receiptDurable: true,
      duplicateIdempotency: true,
      conflictDenied: true,
      crossAccountDenied: true,
      staleEpochDenied: true,
      roleResetCommitRollback: true,
      privateAccessDenied: true,
      unrelatedRoleDenied: true,
      roleCreationDenied: true,
      tempDenied: true,
      wrongDatabasesAndIPv6Denied: true,
      reservationHoldsUnchanged: true,
      providerRequests: 0,
      credentialContentsReadByAgent: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS independent observer tests; durable provisional receipt and all reservation holds verified; fixtures retained",
);
