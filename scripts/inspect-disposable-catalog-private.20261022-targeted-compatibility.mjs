// Fixed read-only operation. No arguments, environment credentials, retries or raw output.
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import {
  reconstructFunctions,
  compareFunction,
} from "./migration-function-comparator.mjs";
import {
  loadPredecessorContracts,
  comparePredecessorCatalog,
} from "./predecessor-contracts.mjs";
const root = path.resolve(import.meta.dirname, "..");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const report = {
  inspection: "BLOCKED",
  target: "UNVERIFIED",
  migration012: "BLOCKED",
  migration013: "BLOCKED",
  migration014: "BLOCKED",
  compatibilityOnly: true,
  migrationsApplied: false,
  qualificationReady: false,
  checks: {},
  adr041: "OPEN",
  transfersEnabled: false,
};
let client,
  password = "",
  ownsAttempt = false;
const output = path.join(
  root,
  "docs/disposable-qualification-catalog-report.20261022-targeted-compatibility.json",
);
try {
  assert.equal(process.argv.length, 2);
  const sql = await fs.readFile(path.join(root, "docs/disposable-targeted-compatibility.20261022-targeted-compatibility.readonly.sql"), "utf8");
  assert.equal(digest(sql), "79e1971bc55848eaa5fe43d5f59372debd35624ddb7ded1d4b1dce38f474b1f8");
  const contract = await loadPredecessorContracts();
  // No secret is read until local source gates pass. One attempt marker, no replay.
  await fs.writeFile(
    path.join(
      root,
      ".cache/browser-roundtrip-20261020/catalog-inspection-once.20261022-targeted-compatibility.json",
    ),
    JSON.stringify({ status: "ATTEMPT_RESERVED", adr041: "OPEN" }),
    { flag: "wx" },
  );
  ownsAttempt = true;
  for await (const chunk of process.stdin) {
    password += chunk.toString("utf8");
    assert.ok(password.length <= 4096);
  }
  assert.ok(password.length > 0);
  client = new pg.Client({
    host: "127.0.0.1",
    port: 55461,
    database: "smart_storage_gateway_test",
    user: "postgres",
    password,
    ssl: false,
    application_name: "smart-storage-private-catalog-readonly",
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    options:
      "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000",
  });
  await client.connect();
  password = "";
  const results = await client.query(sql);
  report.target = "PASS";
  report.inspection = "PASS";
  const catalog = results.find(r => r.fields.some(f => f.name === "predecessor_catalog"))?.rows[0]?.predecessor_catalog;
  assert.ok(catalog);
  const comparison = comparePredecessorCatalog(contract, catalog);
  assert.ok(comparison.diagnostics);
  const scope = ["constraints", "namedConstraints", "triggers", "ACLs", "effectivePrivileges", "columnACLs"];
  report.checks = Object.fromEntries(scope.map(k => [k, comparison.checks[k]]));
  report.diagnostics = comparison.diagnostics;
  report.counts = Object.fromEntries(["constraints", "triggers", "grants", "effectivePrivileges", "columnACLs"].map(k => [k, catalog[k].length]));
  report.catalogDigest = digest(JSON.stringify(catalog));
  report.scope = scope;
  report.historicalEvidence = "Other predecessor categories were not re-inspected; migration statuses remain BLOCKED.";
  report.limitations = ["NO_MIGRATION_OR_RUNTIME_QUALIFICATION", "TARGETED_SCOPE_ONLY"];
  // Catalog capture alone cannot establish exhaustive compatibility. Fail closed.
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    "PASS: Private read-only catalog inspection completed. Compatibility requires report review.",
  );
} catch {
  if (ownsAttempt)
    await fs.writeFile(output, JSON.stringify(report, null, 2)).catch(() => {});
  console.log(
    "FAIL: Private read-only catalog inspection blocked. No retry or credential reset.",
  );
  process.exitCode = 1;
} finally {
  password = "";
  await client?.end().catch(() => {});
}
