// PREPARED ONLY. Operator wrapper is required. Never invoke during offline review.
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { loadPredecessorContracts } from "./predecessor-contracts.mjs";
import {
  evaluatePublicAclProposal,
  affected,
} from "./public-acl-ownership-proposal.mjs";
const root = path.resolve(import.meta.dirname, "..");
// This namespace is historical security state, never relative to staged source.
const protectedRoot = "C:/Users/Admin/Desktop/NEW/smart-storage";
let client,
  password = "",
  reserved = false;
const output = path.join(
  root,
  "docs/public-acl-ownership-evidence.20261022-once-dd28b358ee5a42b7a7323f8a802c4351.json",
);
let report = {
  inspection: "BLOCKED",
  compatibility: "BLOCKED",
  adr041: "OPEN",
  transfersEnabled: false,
  migrationsApplied: false,
};
try {
  assert.equal(process.argv.length, 2);
  const sql = await fs.readFile(
    path.join(root, "docs/targeted-public-acl-ownership.readonly.sql"),
    "utf8",
  );
  assert.equal(
    crypto.createHash("sha256").update(sql).digest("hex"),
    "10722d31f7e704ebfd54b420d3db0df152267ca7e3ef7e4c591a9ccb573cbfef",
  );
  const contract = await loadPredecessorContracts();
  await fs.writeFile(
    path.join(
      protectedRoot,
      ".cache/browser-roundtrip-20261020/public-acl-ownership-once.20261022-once-dd28b358ee5a42b7a7323f8a802c4351.json",
    ),
    JSON.stringify({ status: "ATTEMPT_RESERVED", adr041: "OPEN" }),
    { flag: "wx" },
  );
  reserved = true;
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
    application_name: "smart-storage-public-acl-readonly",
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    options:
      "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000",
  });
  client.on("error", () => {}); // Never expose server/socket errors.
  await client.connect();
  password = "";
  const results = await client.query(sql);
  const evidence = results.find((r) =>
    r.fields.some((f) => f.name === "public_acl_ownership_evidence"),
  )?.rows[0]?.public_acl_ownership_evidence;
  assert.ok(evidence);
  const decision = evaluatePublicAclProposal(evidence, contract);
  // Retain fixed booleans and bounded enum facts, never raw rows/unknown identifiers.
  const bool = (v) => (typeof v === "boolean" ? v : null);
  const names = [
    ...contract.roles.map((r) => r.name),
    "pg_database_owner",
    "PUBLIC",
  ];
  const name = (v) => (names.includes(v) ? v : "UNKNOWN");
  const facts = (rows, build) =>
    Array.isArray(rows) ? rows.slice(0, 128).map((r) => build(r ?? {})) : null;
  report = {
    ...report,
    inspection: "PASS",
    compatibility: decision.status,
    decision,
    facts: {
      roles: facts(evidence.roles, (r) =>
        Object.fromEntries([
          ["name", name(r.name)],
          ...[
            "login",
            "super",
            "inherit",
            "bypass",
            "createRole",
            "createDb",
            "replication",
          ].map((k) => [k, bool(r[k])]),
        ]),
      ),
      memberships: facts(evidence.memberships, (r) => ({
        role: name(r.role),
        member: name(r.member),
        grantor: name(r.grantor),
        admin: bool(r.admin),
        inherit: bool(r.inherit),
        set: bool(r.set),
      })),
      effective: facts(evidence.effective, (r) => ({
        name: name(r.name),
        usage: bool(r.usage),
        create: bool(r.create),
        ownerMember: bool(r.ownerMember),
        ownerUsage: bool(r.ownerUsage),
        ownerSet: bool(r.ownerSet),
      })),
      acl: facts(evidence.acl, (r) => ({
        grantee: name(r.grantee),
        grantor: name(r.grantor),
        privilege: ["USAGE", "CREATE"].includes(r.privilege)
          ? r.privilege
          : "UNKNOWN",
        grantable: bool(r.grantable),
      })),
      counts: Object.fromEntries(
        ["roles", "memberships", "effective", "acl"].map((k) => [
          k,
          Array.isArray(evidence[k]) ? evidence[k].length : null,
        ]),
      ),
    },
    ownership: {
      databaseOwnerIsPostgres: bool(evidence.databaseOwnerIsPostgres),
      schemaOwnerIsDatabaseOwnerRole: bool(
        evidence.schemaOwnerIsDatabaseOwnerRole,
      ),
      aclIsExplicit: bool(evidence.aclIsExplicit),
    },
    grants: affected.map((grantee) => ({
      grantee,
      rows: Array.isArray(evidence.acl)
        ? evidence.acl
            .filter((r) => r?.grantee === grantee)
            .map((r) => ({
              grantor: ["postgres", "pg_database_owner"].includes(r.grantor)
                ? r.grantor
                : "UNKNOWN",
              privilege: ["USAGE", "CREATE"].includes(r.privilege)
                ? r.privilege
                : "UNKNOWN",
              grantable: bool(r.grantable),
            }))
            .slice(0, 16)
        : null,
    })),
    limits: [
      "TARGETED_SCOPE_ONLY",
      "NO_MIGRATION_OR_RUNTIME_QUALIFICATION",
      "OWNER_GRANTOR_REQUIRES_CONTRACT_REVIEW",
    ],
  };
  await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(
    "PASS: Private ACL evidence captured. Review compatibility status; no migration authorization.",
  );
} catch {
  if (reserved)
    await fs
      .writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" })
      .catch(() => {});
  console.log(
    "FAIL: Private ACL inspection blocked. Stop; no retry or credential reset.",
  );
  process.exitCode = 1;
} finally {
  password = "";
  await client?.end().catch(() => {});
}
