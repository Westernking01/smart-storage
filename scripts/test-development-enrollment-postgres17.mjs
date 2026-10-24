import {
  enrollmentChecks,
  enrollmentSql,
} from "../tests/fixtures/development-enrollment-checks.ts";
// Disposable loopback-only PostgreSQL 17. Never consumes a connection URL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import pg from "pg";

const bin =
  process.env.PUBLISHER_TEST_PG_BIN ?? "C:/Program Files/PostgreSQL/17/bin";
const directory = mkdtempSync(join(tmpdir(), "ss-publisher-enrollment-"));
const data = join(directory, "data");
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
  await admin.query(
    "CREATE ROLE postgres LOGIN CREATEROLE; ALTER DATABASE postgres OWNER TO postgres; ALTER SCHEMA public OWNER TO postgres",
  );
  // Bootstrap-authenticated fixture may simulate session identities; all setup
  // executes as non-superuser postgres. This is never a hosted connection.
  const owner = admin;
  await owner.query("SET SESSION AUTHORIZATION postgres");
  await enrollmentChecks(
    {
      exec: (text) => owner.query(text),
      query: (text, values) => owner.query(text, values),
    },
    async () => {
      const login = await connect("ss_dev_cloud_publisher_login");
      try {
        await login.query("DISCARD ALL");
        await login.query(
          enrollmentSql("publisher-enrollment-preflight.readonly.sql").replace(
            "DISCARD ALL;",
            "",
          ),
        );
        await assert.rejects(
          owner.query(enrollmentSql("rollback-enrollment.sql")),
          /Stop publisher connections/,
        );
        await owner.query("ROLLBACK");
      } finally {
        await login.end();
        clients.splice(clients.indexOf(login), 1);
      }
    },
  );
  console.log(
    "PASS: native PostgreSQL 17 enrollment/context/ACL/rollback matrix; no TLS or hosted claim",
  );
} finally {
  for (const client of clients) await client.end();
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  console.log("Disposable cluster stopped; local evidence: " + directory);
}
