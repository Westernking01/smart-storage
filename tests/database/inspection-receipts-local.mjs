// Authorized disposable local DB only. No roles/grants/migrations/credentials read.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const namespace = randomUUID().slice(0, 8);
const id = (p) => `${p}${namespace.slice(1)}-0000-0000-0000-000000000001`;
const transform = (s) =>
  s.replace(/([0-9a-d])0000000-0000-0000-0000-/g, (_, p) => id(p).slice(0, 24));
let fixture = transform(
  readFileSync("tests/database/gateway-claims-fixture.sql", "utf8"),
);
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
let sql = transform(
  readFileSync("tests/database/gateway-evidence-contract.sql", "utf8"),
);
for (const name of [
  "evidence_assert",
  "evidence_error",
  "test_register",
  "test_receipt",
])
  sql = sql.replaceAll("public." + name, "pg_temp." + name);
sql = sql
  .replaceAll(
    "from app_private.gateway_resources)",
    `from app_private.gateway_resources where owner_id='${id(0)}')`,
  )
  .replaceAll(
    "from app_private.gateway_observation_receipts)",
    `from app_private.gateway_observation_receipts where owner_id='${id(0)}')`,
  )
  .replaceAll(
    "where kind='manifest'",
    `where owner_id='${id(0)}' and kind='manifest'`,
  );
sql = sql.replace(
  "'delete from app_private.gateway_observation_receipts'",
  `$q$delete from app_private.gateway_observation_receipts where owner_id='${id(0)}'$q$`,
);
// Entire test transaction, including namespaced fixtures, rolls back.
sql = sql.replace(
  "begin;",
  () =>
    `begin; do $$ begin if current_database()<>'smart_storage_gateway_test' or inet_server_addr()<>'127.0.0.1'::inet or inet_server_port()<>5432 then raise exception 'WRONG_LOCAL_TARGET'; end if; end $$; ${fixture}`,
);
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
env.PGCONNECT_TIMEOUT = "3";
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
  { env, input: sql, encoding: "utf8", timeout: 30000 },
);
if (r.error || r.status !== 0) throw Error(r.error?.message ?? r.stderr);
const report = {
  status: "PASS",
  scope:
    "Existing observer receipt SQL contract; isolated namespaced fixtures; transaction ROLLBACK",
  namespace,
  checks: [
    "scope/owner/epoch binding",
    "duplicate idempotency",
    "conflicting payload rejection",
    "provisional-only immutable receipts",
    "historical fencing",
    "reservation and slot holds",
    "role denial",
  ],
  runtimeObserverAuthentication: false,
  providerRequests: 0,
  newRoles: 0,
  newGrants: 0,
};
writeFileSync(
  "tests/database/inspection-receipts-results.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
