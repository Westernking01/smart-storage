import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  loadPredecessorContracts,
  comparePredecessorCatalog,
  expression,
  assertSourcePin,
} from "./predecessor-contracts.mjs";
import crypto from "node:crypto";
import { compareFunction } from "./migration-function-comparator.mjs";

const contract = await loadPredecessorContracts();
// Synthetic catalog only. No pg/PGlite imports, subprocesses, network or SQL
// execution. This factory encodes the disposable bootstrap's grant model, not
// any observed/live catalog. PostgreSQL rendering examples are tested below.
function fixture() {
  const clone = structuredClone;
  const tables = contract.tables.map(({ name, owner, rls, forceRls }) => ({
    name,
    owner,
    rls,
    forceRls,
    persistence: "p",
    partition: false,
    options: null,
    replica: "d",
    access: "heap",
    inherits: false,
  }));
  const c = {
    version: 1,
    roles: clone(contract.roles),
    memberships: clone(contract.memberships),
    defaultACLs: [],
    roleSettings: [
      {
        role: "ss_volume_runtime",
        database: "smart_storage_gateway_test",
        config: ['search_path=""'],
      },
    ],
    names: {
      relations: tables.map((t) => t.name.split(".")[1]),
      functions: contract.functions.map((f) => f.name.split(".")[1]),
      triggers: contract.triggers.map((t) => t.name),
    },
    tables,
    columns: contract.tables.flatMap((t) =>
      t.columns.map((col) => ({ table: t.name, ...clone(col) })),
    ),
    constraints: contract.tables.flatMap((t) =>
      t.constraints.map((con) => ({
        table: t.name,
        ...clone(con),
        noInherit: false,
        foreignActions: con.kind === "foreign" ? "aas" : null,
      })),
    ),
    indexes: clone(contract.indexes),
    constraintIndexesValid: true,
    triggers: clone(contract.triggers),
    policies: clone(contract.policies),
    functions: contract.functions.map((f) => ({
      name: f.name,
      ...clone(f.security),
      definition: f.definition,
    })),
    grants: [],
    effectivePrivileges: [],
    columnACLs: [],
    schemaOwners: {
      public: "pg_database_owner",
      app_private: "postgres",
      auth: "postgres",
    },
    databaseBoundary: true,
    otherObjects: [],
    routineKindsValid: true,
    rewriteRules: [],
    eventTriggers: [],
  };
  // Patch bodies must be substituted in their original CREATE header.
  c.functions.forEach((f, i) => {
    f.definition = f.definition.replace(
      /(\bas\s+)(\$\w*\$)[\s\S]*?\2\s*;?\s*$/i,
      (_m, as, delimiter) =>
        `${as}${delimiter}${contract.functions[i].body}${delimiter};`,
    );
  });
  const add = (kind, object, grantee, privilege, grantor = "postgres") =>
    c.grants.push({
      kind,
      object,
      grantee,
      privilege,
      grantable: false,
      grantor,
    });
  const operations = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ];
  for (const t of tables) {
    for (const op of operations) add("table", t.name, "postgres", op);
    if (contract.readable.includes(t.name))
      add("table", t.name, "authenticated", "SELECT");
  }
  for (const f of c.functions) {
    for (const grantee of ["postgres", ...f.execute])
      add("function", f.name, grantee, "EXECUTE");
  }
  for (const schema of ["auth", "app_private"])
    for (const op of ["USAGE", "CREATE"]) add("schema", schema, "postgres", op);
  add("schema", "app_private", "authenticated", "USAGE");
  for (const role of ["anon", "authenticated", "service_role"])
    add("schema", "auth", role, "USAGE");
  for (const op of ["USAGE", "CREATE"])
    add("schema", "public", "pg_database_owner", op, "pg_database_owner");
  add("schema", "public", "PUBLIC", "USAGE", "pg_database_owner");
  for (const role of [
    "ss_gateway_executor",
    "ss_gateway_observer",
    "ss_gateway_finalizer",
    "ss_gateway_cleaner",
    "ss_volume_gateway",
  ])
    add("schema", "public", role, "USAGE");
  for (const r of c.roles.filter((r) => !r.super)) {
    for (const t of tables)
      for (const privilege of operations)
        c.effectivePrivileges.push({
          role: r.name,
          kind: "table",
          object: t.name,
          privilege,
          allowed: c.grants.some(
            (g) =>
              g.kind === "table" &&
              g.object === t.name &&
              g.privilege === privilege &&
              [r.name, "PUBLIC"].includes(g.grantee),
          ),
        });
    for (const f of c.functions)
      c.effectivePrivileges.push({
        role: r.name,
        kind: "function",
        object: f.name,
        privilege: "EXECUTE",
        allowed: [r.name, "PUBLIC"].some((n) => f.execute.includes(n)),
      });
    for (const object of ["public", "app_private", "auth"])
      for (const privilege of ["USAGE", "CREATE"])
        c.effectivePrivileges.push({
          role: r.name,
          kind: "schema",
          object,
          privilege,
          allowed: c.grants.some(
            (g) =>
              g.kind === "schema" &&
              g.object === object &&
              g.privilege === privilege &&
              [r.name, "PUBLIC"].includes(g.grantee),
          ),
        });
  }
  return c;
}

test("trigger delimiter normalization is integrated without accepting disabled triggers", () => {
  const catalog = fixture();
  catalog.triggers.forEach((t) => (t.definition += ";"));
  const matched = comparePredecessorCatalog(contract, catalog);
  assert.equal(matched.checks.triggers, "PASS");
  assert.equal(matched.diagnostics.triggers.status, "PASS");
  catalog.triggers[0].enabled = "D";
  const blocked = comparePredecessorCatalog(contract, catalog);
  assert.equal(blocked.checks.triggers, "BLOCKED");
  assert.deepEqual(blocked.diagnostics.triggers.entries[0].changedFields, [
    "enabled",
  ]);
});

test("pinned source reconstructs the customized through-011 structure", () => {
  assert.equal(contract.tables.length, 37);
  assert.equal(
    contract.tables.reduce((n, t) => n + t.columns.length, 0),
    311,
  );
  assert.equal(
    contract.tables
      .filter((t) => !t.name.startsWith("auth."))
      .reduce((n, t) => n + t.constraints.length, 0),
    246,
  );
  assert.equal(contract.indexes.length, 13);
  assert.equal(contract.triggers.length, 41);
  assert.equal(contract.functions.length, 59); // 57 public/private plus bootstrap auth helpers
  assert.equal(contract.policies.length, 8);
  assert.equal(
    contract.tables
      .find((t) => t.name === "public.profiles")
      .constraints.find((c) => c.kind === "foreign").definition.target,
    "app_private.local_principals",
  );
  assert.equal(
    contract.tables
      .find((t) => t.name === "app_private.gateway_requests")
      .columns.find((c) => c.name === "attempt_id").nullable,
    true,
  );
  assert.ok(
    !contract.tables
      .find((t) => t.name === "app_private.gateway_requests")
      .constraints.some((c) => c.definition === "check ( slot_held )"),
  );
});
test("source drift requires review, including candidate migration bytes", () => {
  const source = "reviewed SQL";
  const pin = crypto.createHash("sha256").update(source).digest("hex");
  assert.doesNotThrow(() => assertSourcePin(source, pin));
  assert.throws(
    () => assertSourcePin(source + " ", pin),
    /SOURCE_REVIEW_REQUIRED/,
  );
  assert.equal(
    Object.keys(contract.pins).filter((p) => /001[234]_/.test(p)).length,
    3,
  );
});
test("complete synthetic matching contract passes; jsonb key/row order is immaterial", () => {
  const c = fixture();
  c.columns.reverse();
  c.roles.reverse();
  const reorder = (value) =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([k, v]) => [k, reorder(v)]),
          )
        : value;
  const result = comparePredecessorCatalog(contract, reorder(c));
  assert.equal(result.status, "PASS", JSON.stringify(result.checks));
});
const cases = {
  missingTable: (c) => c.tables.pop(),
  unexpectedTable: (c) =>
    c.tables.push({ ...c.tables[0], name: "public.unreviewed" }),
  missingColumn: (c) => c.columns.pop(),
  changedColumnOrder: (c) => {
    c.columns[0].position = 2;
  },
  changedColumnType: (c) => {
    c.columns[0].type = "text";
  },
  changedDefault: (c) => {
    c.columns.find(
      (x) => x.table === "public.file_blocks" && x.name === "state",
    ).default = "'present'";
  },
  missingConstraint: (c) => c.constraints.pop(),
  invalidConstraint: (c) => {
    c.constraints[0].validated = false;
  },
  checkNoInherit: (c) => {
    c.constraints.find((x) => x.kind === "check").noInherit = true;
  },
  cascadingForeignKey: (c) => {
    c.constraints.find((x) => x.kind === "foreign").foreignActions = "acs";
  },
  wrongProfileFK: (c) => {
    c.constraints.find(
      (x) => x.table === "public.profiles" && x.kind === "foreign",
    ).definition.target = "auth.users";
  },
  weakerQuota: (c) => {
    c.constraints.find(
      (x) =>
        x.table === "public.user_usage" && typeof x.definition === "string",
    ).definition = "check (true)";
  },
  missingIndex: (c) => c.indexes.pop(),
  nonuniqueStreamIndex: (c) => {
    c.indexes.find(
      (x) => x.name === "gateway_one_stream_per_session",
    ).definition =
      "create index gateway_one_stream_per_session on app_private.gateway_requests(session_id) where slot_held";
  },
  invalidConstraintIndex: (c) => {
    c.constraintIndexesValid = false;
  },
  disabledAdmission: (c) => {
    c.triggers.find((x) => x.name === "gateway_reservation_admission").enabled =
      "D";
  },
  missingImmutableTrigger: (c) => {
    c.triggers.splice(
      c.triggers.findIndex((x) => x.name === "volume_no_alternate_writer"),
      1,
    );
  },
  extraTrigger: (c) => c.triggers.push({ ...c.triggers[0], name: "bypass" }),
  rlsDisabled: (c) => {
    c.tables.find((x) => x.name === "app_private.local_principals").rls = false;
  },
  ownerChanged: (c) => {
    c.tables[0].owner = "authenticated";
  },
  extraPolicy: (c) =>
    c.policies.push({ ...c.policies[0], name: "allow_all", using: "true" }),
  broadPolicy: (c) => {
    c.policies[0].roles = ["PUBLIC"];
  },
  missingFunction: (c) => c.functions.pop(),
  extraOverload: (c) =>
    c.functions.push({ ...c.functions[0], arguments: "p_owner uuid" }),
  functionOwner: (c) => {
    c.functions[0].proowner = "authenticated";
  },
  functionSearchPath: (c) => {
    c.functions[0].proconfig = ["search_path=public"];
  },
  functionMode: (c) => {
    c.functions[0].prosecdef = true;
  },
  functionVolatility: (c) => {
    c.functions[0].volatility = "i";
  },
  alteredDispatch: (c) => {
    const f = c.functions.find(
      (x) => x.name === "public.ss_gateway_resolve_dispatch_v1",
    );
    f.definition = f.definition.replace("FORBIDDEN", "ALLOWED");
  },
  publicExecute: (c) =>
    c.grants.push({
      kind: "function",
      object: "public.ss_volume_command",
      grantee: "PUBLIC",
      privilege: "EXECUTE",
      grantable: false,
      grantor: "postgres",
    }),
  grantOption: (c) => {
    c.grants[0].grantable = true;
  },
  missingGrant: (c) => c.grants.pop(),
  effectivePrivilege: (c) => {
    c.effectivePrivileges.find(
      (x) => x.role === "ss_volume_runtime" && x.kind === "table",
    ).allowed = true;
  },
  missingEffectiveEvidence: (c) => c.effectivePrivileges.pop(),
  columnGrant: (c) =>
    c.columnACLs.push({ table: "public.files", column: "id", acl: "unsafe" }),
  roleEscalation: (c) => {
    c.roles.find((x) => x.name === "ss_volume_runtime").replication = true;
  },
  inheritedMembership: (c) => {
    c.memberships[0].inherit = true;
  },
  extraMembership: (c) =>
    c.memberships.push({
      role: "pg_read_all_data",
      member: "ss_volume_runtime",
      admin: false,
      inherit: true,
      set: true,
    }),
  defaultGrant: (c) => c.defaultACLs.push({ role: "postgres", acl: "unsafe" }),
  runtimeSetting: (c) => {
    c.roleSettings[0].config = ["search_path=public"];
  },
  schemaOwnership: (c) => {
    c.schemaOwners.public = "authenticated";
  },
  databaseConnect: (c) => {
    c.databaseBoundary = false;
  },
  unsupportedRelation: (c) => c.otherObjects.push("public.unreviewed_view"),
  partialMigration: (c) =>
    c.names.functions.push("ss_registered_block_dispatch_v1"),
  collisionRelationKind: (c) => c.names.relations.push("prepared_block_plans"),
  hiddenProcedure: (c) => {
    c.routineKindsValid = false;
  },
  rewriteRule: (c) => c.rewriteRules.push("unreviewed_rule"),
  eventTrigger: (c) => c.eventTriggers.push("unreviewed_event_trigger"),
};
for (const [name, mutate] of Object.entries(cases))
  test(`${name} blocks compatibility`, () => {
    const c = fixture();
    mutate(c);
    assert.equal(comparePredecessorCatalog(contract, c).status, "BLOCKED");
  });
test("missing/malformed sections and booleans never pass", () => {
  assert.equal(comparePredecessorCatalog(contract, null).status, "BLOCKED");
  for (const key of Object.keys(fixture())) {
    const c = fixture();
    delete c[key];
    assert.equal(comparePredecessorCatalog(contract, c).status, "BLOCKED", key);
  }
  assert.equal(
    comparePredecessorCatalog(contract, { version: 1, functions: {} }).status,
    "BLOCKED",
  );
});
test("every versioned function security field is independently mandatory", () => {
  const f = contract.functions.find(
    (f) => f.name === "public.ss_gateway_claim_v1",
  );
  const row = fixture().functions.find((r) => r.name === f.name);
  assert.equal(compareFunction(f, [row], f.security).status, "PASS");
  for (const key of Object.keys(f.security).filter(
    (k) => k !== "contractVersion",
  )) {
    const altered = structuredClone(row);
    delete altered[key];
    assert.equal(
      compareFunction(f, [altered], f.security).status,
      "BLOCKED",
      key,
    );
  }
  assert.equal(compareFunction(f, [], f.security).status, "BLOCKED");
});
test("reviewed PostgreSQL expression renderings agree without erasing grouping", () => {
  for (const [a, b] of [
    [
      "check(max_slots between 0 and 2)",
      "CHECK (((max_slots >= 0) AND (max_slots <= 2)))",
    ],
    [
      "state in ('active','revoked')",
      "(state = ANY (ARRAY['active'::text, 'revoked'::text]))",
    ],
    [
      "state not in ('present','settled')",
      "state <> ALL (ARRAY['present'::text,'settled'::text])",
    ],
    [
      "owner_id=(select app_private.actor())",
      "(owner_id = ( SELECT app_private.actor() AS actor))",
    ],
    ["'allocated'", "'allocated'::text"],
  ])
    assert.equal(expression(a), expression(b), a);
  for (const [a, b] of [
    ["a and (b or c)", "(a and b) or c"],
    ["a+b*c", "(a+b)*c"],
    ["x::numeric+y", "x+y"],
    ["'A'", "'a'"],
    ["not x = y", "(not x) = y"],
  ])
    assert.notEqual(expression(a), expression(b));
});
test("inspector retains guarded original SQL and adds pinned evidence before rollback", async () => {
  const source = await fs.readFile(
    new URL("./inspect-disposable-catalog-private.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /loadPredecessorContracts\(\)/);
  assert.match(source, /comparePredecessorCatalog\(/);
  assert.match(source, /evidenceSql \+ "\\n" \+ privilegeSql/);
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /flag: "wx"/);
  assert.match(source, /port: 55461/);
  const sql = await fs.readFile(
    new URL(
      "../docs/disposable-predecessor-evidence.readonly.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|alter|create|drop|grant|revoke|commit)\b\s+(?:into|table|role|function|schema|database)/i,
  );
  assert.match(sql, /has_table_privilege/);
  assert.match(sql, /aclexplode/);
  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  assert.ok(
    source.includes(hash),
    "new evidence SQL must stay hash-pinned before credentials",
  );
});
