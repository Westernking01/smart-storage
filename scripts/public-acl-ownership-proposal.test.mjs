import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { loadPredecessorContracts } from "./predecessor-contracts.mjs";
import {
  affected,
  evaluatePublicAclProposal as evaluate,
} from "./public-acl-ownership-proposal.mjs";
const contract = await loadPredecessorContracts();
function fixture(grantor = "postgres") {
  const roles = [
    ...structuredClone(contract.roles),
    {
      name: "pg_database_owner",
      login: false,
      super: false,
      inherit: true,
      bypass: false,
      createRole: false,
      createDb: false,
      replication: false,
    },
  ];
  return {
    version: 1,
    targetVerified: true,
    databaseOwnerIsPostgres: true,
    schemaOwnerIsDatabaseOwnerRole: true,
    aclIsExplicit: true,
    roles,
    memberships: contract.memberships.map((r) => ({
      ...r,
      grantor: "postgres",
    })),
    acl: [
      ...affected.map((grantee) => ({
        grantee,
        grantor,
        privilege: "USAGE",
        grantable: false,
      })),
      ...["USAGE", "CREATE"].map((privilege) => ({
        grantee: "pg_database_owner",
        grantor: "pg_database_owner",
        privilege,
        grantable: false,
      })),
      {
        grantee: "PUBLIC",
        grantor: "pg_database_owner",
        privilege: "USAGE",
        grantable: false,
      },
    ],
    effective: roles.map((r) => {
      const owner = ["postgres", "pg_database_owner"].includes(r.name);
      return {
        name: r.name,
        usage: true,
        create: owner,
        ownerMember: owner,
        ownerUsage: owner,
        ownerSet: owner,
      };
    }),
  };
}
test("literal predecessor provenance passes only the targeted check", () => {
  const r = evaluate(fixture(), contract);
  assert.equal(r.status, "PASS");
  assert.equal(r.entries.length, 5);
  assert.equal(r.migrationsApplied, false);
  assert.equal(r.qualificationReady, false);
});
for (const name of affected) {
  test(`${name}: owner grant requires contract review even with authority proven`, () => {
    const e = fixture();
    e.acl.find((r) => r.grantee === name).grantor = "pg_database_owner";
    const r = evaluate(e, contract);
    assert.equal(r.status, "BLOCKED");
    assert.equal(
      r.entries.find((r) => r.grantee === name).reason,
      "OWNER_AUTHORITY_DEMONSTRATED_CONTRACT_REVIEW_REQUIRED",
    );
  });
  for (const [label, change] of Object.entries({
    missing: (e) => {
      e.acl = e.acl.filter((r) => r.grantee !== name);
    },
    duplicate: (e) => e.acl.push({ ...e.acl.find((r) => r.grantee === name) }),
    grantOption: (e) => {
      e.acl.find((r) => r.grantee === name).grantable = true;
    },
    unknownGrantor: (e) => {
      e.acl.find((r) => r.grantee === name).grantor = "SECRET_UNKNOWN_ROLE";
    },
    create: (e) => {
      e.acl.find((r) => r.grantee === name).privilege = "CREATE";
    },
    effectiveCreate: (e) => {
      e.effective.find((r) => r.name === name).create = true;
    },
    ownerSet: (e) => {
      e.effective.find((r) => r.name === name).ownerSet = true;
    },
  }))
    test(`${name}: ${label} conflicts`, () => {
      const e = fixture();
      change(e);
      const r = evaluate(e, contract);
      assert.equal(r.status, "CONFLICT");
      assert.ok(!JSON.stringify(r).includes("SECRET_UNKNOWN_ROLE"));
    });
}
for (const [label, change, status] of [
  [
    "missing section",
    (e) => {
      delete e.acl;
    },
    "BLOCKED",
  ],
  [
    "extra section",
    (e) => {
      e.secret = "SECRET";
    },
    "BLOCKED",
  ],
  [
    "nonboolean",
    (e) => {
      e.databaseOwnerIsPostgres = "true";
    },
    "BLOCKED",
  ],
  [
    "wrong target",
    (e) => {
      e.targetVerified = false;
    },
    "BLOCKED",
  ],
  [
    "wrong database owner",
    (e) => {
      e.databaseOwnerIsPostgres = false;
    },
    "CONFLICT",
  ],
  [
    "wrong schema owner",
    (e) => {
      e.schemaOwnerIsDatabaseOwnerRole = false;
    },
    "CONFLICT",
  ],
  [
    "default ACL only",
    (e) => {
      e.aclIsExplicit = false;
    },
    "BLOCKED",
  ],
  ["role missing", (e) => e.roles.pop(), "BLOCKED"],
  ["effective role missing", (e) => e.effective.pop(), "BLOCKED"],
  [
    "role escalation",
    (e) => {
      e.roles.find((r) => r.name === affected[0]).super = true;
    },
    "CONFLICT",
  ],
  [
    "unexpected membership",
    (e) =>
      e.memberships.push({
        role: "pg_database_owner",
        member: affected[0],
        grantor: "postgres",
        admin: false,
        inherit: false,
        set: true,
      }),
    "CONFLICT",
  ],
  [
    "membership grantor drift",
    (e) => {
      e.memberships[0].grantor = "pg_database_owner";
    },
    "CONFLICT",
  ],
  [
    "PUBLIC CREATE",
    (e) =>
      e.acl.push({
        grantee: "PUBLIC",
        grantor: "pg_database_owner",
        privilege: "CREATE",
        grantable: false,
      }),
    "CONFLICT",
  ],
  [
    "missing direct grant despite effective PUBLIC usage",
    (e) => {
      e.acl = e.acl.filter((r) => r.grantee !== affected[0]);
    },
    "CONFLICT",
  ],
])
  test(label, () => {
    const e = fixture("pg_database_owner");
    change(e);
    assert.equal(evaluate(e, contract).status, status);
  });
test("all owner grantors remain blocked, never globally aliased", () => {
  assert.ok(
    evaluate(fixture("pg_database_owner"), contract).entries.every(
      (r) => r.status === "BLOCKED",
    ),
  );
});
test("SQL stays metadata-only and target guarded with final rollback", () => {
  const sql = fs.readFileSync(
    new URL(
      "../docs/targeted-public-acl-ownership.readonly.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(sql.indexOf("TARGET_BLOCKED") < sql.indexOf("with names"));
  assert.match(sql, /repeatable read read only/i);
  assert.match(sql, /rollback;\s*$/i);
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|create|alter|drop|grant|revoke|commit)\s+(?:table|role|schema|into|on|database)\b/i,
  );
  assert.doesNotMatch(sql, /pg_authid|rolpassword|public\./i);
  for (const name of affected) assert.ok(sql.includes("'" + name + "'"));
});
test("prepared host pins SQL and reserves an exclusive attempt before stdin/connect", () => {
  const host = fs.readFileSync(
    new URL("./inspect-public-acl-ownership-private.mjs", import.meta.url),
    "utf8",
  );
  const exclusive = host.search(/flag:\s*"wx"/);
  assert.ok(exclusive >= 0 && exclusive < host.indexOf("process.stdin"));
  assert.ok(
    host.indexOf("process.stdin") < host.indexOf("await client.connect()"),
  );
  assert.match(host, /default_transaction_read_only=on/);
  assert.match(host, /127\.0\.0\.1/);
  assert.match(host, /port:\s*55461/);
  assert.doesNotMatch(
    host,
    /process\.env|console\.(?:log|error)\(e(?:rror)?\b/,
  );
  const sql = fs.readFileSync(
    new URL(
      "../docs/targeted-public-acl-ownership.readonly.sql",
      import.meta.url,
    ),
  );
  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  assert.ok(host.includes(hash));
});
