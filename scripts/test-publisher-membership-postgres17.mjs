// Disposable loopback-only PostgreSQL 17. Never consumes a connection URL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import pg from "pg";

const bin =
  process.env.PUBLISHER_TEST_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const directory = mkdtempSync(join(tmpdir(), "ss-publisher-membership-"));
const data = join(directory, "data");
const root = resolve("supabase/development-cloud");
const sql = (file) =>
  readFileSync(join(root, file), "utf8")
    .replace(/^\\ir (.*)$/gm, (_, child) => sql(child.trim()))
    .replace(/^\\.*$/gm, "");
const run = (name, args) => {
  const result = spawnSync(join(bin, name + ".exe"), args, {
    windowsHide: true,
    encoding: "utf8",
    stdio: name === "pg_ctl" ? "ignore" : "pipe",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
};
const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
let started = false;
const clients = [];
const connect = async (user) => {
  const client = new pg.Client({
    host: "127.0.0.1",
    port,
    database: "postgres",
    user,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  clients.push(client);
  return client;
};
try {
  run("initdb", [
    "-D",
    data,
    "-U",
    "fixture_bootstrap",
    "-A",
    "trust",
    "--no-locale",
    "-E",
    "UTF8",
  ]);
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    join(directory, "server.log"),
    "-o",
    `-h 127.0.0.1 -p ${port}`,
    "-w",
    "start",
  ]);
  started = true;
  const admin = await connect("fixture_bootstrap");
  const version = (await admin.query("SHOW server_version_num")).rows[0]
    .server_version_num;
  assert.equal(Math.floor(Number(version) / 10000), 17);
  await admin.query(`CREATE ROLE postgres LOGIN CREATEROLE;
    ALTER DATABASE postgres OWNER TO postgres;
    ALTER SCHEMA public OWNER TO postgres;`);
  const owner = await connect("postgres");
  await owner.query(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE ROLE service_role; CREATE ROLE authenticator;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE SCHEMA storage;
    CREATE TABLE storage.objects(bucket_id text,name text,owner_id text,metadata jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  // auth helpers are installed before migrations; sources match the captured contract.
  for (const row of JSON.parse(
    readFileSync(
      "tests/fixtures/development-cloud-live-auth-baseline.json",
      "utf8",
    ),
  )) {
    if (row.nspname === "auth") await owner.query(row.definition);
  }
  for (const file of [
    "202610130001_backend_schema.sql",
    "202610130002_control_functions.sql",
    "202610130003_trusted_transitions_and_rls.sql",
  ]) {
    await owner.query(readFileSync("supabase/migrations/" + file, "utf8"));
  }
  await owner.query(sql("install.sql"));
  await owner.query("SET app.settings.project_ref='fneuqneqaopkmpeevlqz'");
  const provision = sql("provision-publisher-login.sql");
  const assertion = sql("publisher-permissions.assert.sql");
  const legacy = assertion.replace(
    /OR \(roleid='ss_dev_cloud_publisher_login'.*?\)\)\)/,
    "OR roleid='ss_dev_cloud_publisher_login'::pg_catalog.regrole",
  );
  assert.notEqual(legacy, assertion);
  await assert.rejects(
    owner.query(provision.replace(assertion, legacy)),
    /Publisher membership closure drift/,
  );
  await owner.query("ROLLBACK");
  assert.equal(
    (
      await owner.query(
        "SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher_login'",
      )
    ).rowCount,
    0,
  );
  console.log(
    "PASS: original assertion reproduced membership failure; rollback removed LOGIN (PostgreSQL " +
      version +
      ")",
  );
  await owner.query(
    "CREATE SCHEMA extensions; CREATE VIEW extensions.pg_stat_statements AS SELECT 1 value; CREATE VIEW extensions.pg_stat_statements_info AS SELECT 1 value; GRANT SELECT ON extensions.pg_stat_statements,extensions.pg_stat_statements_info TO PUBLIC;",
  );
  await owner.query("GRANT USAGE ON SCHEMA extensions TO PUBLIC");
  await assert.rejects(owner.query(provision), /relation privilege exposure/);
  await owner.query("ROLLBACK");
  assert.equal(
    (
      await owner.query(
        "SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher_login'",
      )
    ).rowCount,
    0,
  );
  await owner.query("REVOKE USAGE ON SCHEMA extensions FROM PUBLIC");
  await owner.query(provision);
  for (const test of JSON.parse(
    readFileSync("tests/fixtures/publisher-monitoring-privileges.json", "utf8"),
  )) {
    await (test.admin ? admin : owner).query(test.setup);
    await assert.rejects(owner.query(assertion), new RegExp(test.error));
    await (test.admin ? admin : owner).query(test.undo);
    await owner.query(assertion);
  }
  console.log(
    "PASS: both inaccessible monitoring views and all monitoring privilege regressions",
  );
  assert.deepEqual(
    (
      await owner.query(
        "SELECT member::regrole::text member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid='ss_dev_cloud_publisher_login'::regrole",
      )
    ).rows,
    [
      {
        member: "postgres",
        grantor: 10,
        admin_option: true,
        inherit_option: false,
        set_option: false,
      },
    ],
  );
  const login = await connect("ss_dev_cloud_publisher_login");
  await login.query(assertion);
  assert.equal(
    (
      await login.query(
        "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
      )
    ).rows[0].ssl,
    false,
  );
  await login.query(
    "SET ROLE ss_dev_cloud_publisher; SET request.jwt.claims='{}'",
  );
  // Match psql's statement boundary for DISCARD ALL.
  await login.query("DISCARD ALL");
  await login.query(
    sql("publisher-preflight.readonly.sql").replace("DISCARD ALL;", ""),
  );
  // Match psql's statement boundary for DISCARD ALL.
  await login.query("DISCARD ALL");
  await login.query(
    sql("publisher-preflight.readonly.sql").replace("DISCARD ALL;", ""),
  );
  run("psql", [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "ss_dev_cloud_publisher_login",
    "-d",
    "postgres",
    "-X",
    "-f",
    join(root, "publisher-preflight.readonly.sql"),
  ]);
  console.log(
    "PASS: read-only preflight, dirty-session reset, identity/role restoration and backend ssl=false; no client TLS qualification claimed",
  );
  for (const view of ["pg_stat_statements", "pg_stat_statements_info"]) {
    await assert.rejects(
      login.query("SELECT * FROM extensions." + view),
      /permission denied for schema/,
    );
    await login.query("BEGIN; SET LOCAL ROLE ss_dev_cloud_publisher");
    await assert.rejects(
      login.query("SELECT * FROM extensions." + view),
      /permission denied for schema/,
    );
    await login.query("ROLLBACK");
  }
  await login.query("BEGIN; SET LOCAL ROLE ss_dev_cloud_publisher; ROLLBACK");
  await assert.rejects(login.query("SET ROLE postgres"), /permission denied/);
  await login.end();
  clients.splice(clients.indexOf(login), 1);
  await owner.query(sql("rollback-publisher-login.sql"));
  assert.equal(
    (
      await owner.query(
        "SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher_login'",
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await owner.query(
        "SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher'",
      )
    ).rowCount,
    1,
  );
  console.log(
    "PASS: fixed provisioning, restricted-login assertion/SET ROLE, escalation denial and rollback",
  );
} finally {
  for (const client of clients) await client.end();
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  console.log("Disposable cluster stopped; local evidence: " + directory);
}
