// Invoked only by the private PowerShell wrapper. No credential arguments/files/env.
import pg from "pg";
import path from "node:path";
import assert from "node:assert/strict";

let password = "";
let client;
try {
  for await (const chunk of process.stdin) {
    password += chunk.toString("utf8");
    if (password.length > 4096) throw Error("INPUT_BOUND");
  }
  if (!password) throw Error("INPUT_REQUIRED");
  client = new pg.Client({
    host: "127.0.0.1",
    port: 55461,
    database: "smart_storage_gateway_test",
    user: "postgres",
    password,
    ssl: false,
    application_name: "smart-storage-private-readonly-preflight",
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    options: "-c default_transaction_read_only=on -c statement_timeout=5000",
  });
  await client.connect();
  password = "";
  await client.query("begin read only");
  const {
    rows: [target],
  } = await client.query(`select current_database() db,
    current_user usr, current_setting('data_directory') dir,
    inet_server_port() port, host(inet_server_addr()) addr,
    current_setting('listen_addresses') listen,
    current_setting('server_version_num') version,
    current_setting('transaction_read_only') readonly`);
  assert.equal(target.db, "smart_storage_gateway_test");
  assert.equal(target.usr, "postgres");
  assert.equal(target.port, 55461);
  assert.equal(target.addr, "127.0.0.1");
  assert.equal(target.listen, "127.0.0.1");
  assert.equal(target.readonly, "on");
  assert.equal(Math.floor(Number(target.version) / 10000), 17);
  assert.equal(
    path.resolve(target.dir).toLowerCase(),
    path
      .resolve(
        "C:/Users/Admin/Desktop/NEW/smart-storage/.cache/browser-roundtrip-20261020/postgres",
      )
      .toLowerCase(),
  );
  const { rows: catalog } = await client.query(`select
    to_regclass('app_private.prepared_block_bindings') is not null bindings,
    to_regclass('app_private.prepared_block_plans') is not null plans,
    to_regprocedure('public.ss_prepared_manifest_register_v1(uuid,uuid,text,text,text,uuid,uuid,jsonb)') is not null registrar,
    to_regprocedure('public.ss_registered_block_dispatch_v1(uuid,uuid,jsonb)') is not null dispatch,
    (select count(*)::int from public.profiles) profiles,
    (select count(*)::int from public.upload_sessions) sessions,
    (select count(*)::int from app_private.gateway_requests where slot_held) held_requests,
    (select count(*)::int from pg_trigger where tgname='gateway_reservation_admission' and tgenabled='O') admission_triggers`);
  await client.query("rollback");
  console.log(
    JSON.stringify({
      status: "READ_ONLY_PREFLIGHT_PASS",
      target,
      catalog,
      qualificationReady: false,
      migrationsApplied: false,
      adr041: "OPEN",
    }),
  );
} catch {
  console.error("PRIVATE_DISPOSABLE_PREFLIGHT_BLOCKED");
  process.exitCode = 1;
} finally {
  password = "";
  await client?.end().catch(() => {});
}
