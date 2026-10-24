// Offline only: finite interpreter for hash-pinned, reviewed predecessor DDL.
// Never imports a database driver, executes SQL, or reads credentials.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  reconstructFunctions,
  tokens,
  compareFunction,
} from "./migration-function-comparator.mjs";
import { expressionContract } from "./predecessor-expressions.mjs";
import {
  diagnoseObjects,
  triggerContract,
} from "./predecessor-diagnostics.mjs";

const root = path.resolve(import.meta.dirname, "..");
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const lex = (s) => tokens(s) ?? [];
const sql = (t) => t.join(" ");
const canonical = (s) => sql(lex(s));
const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");
export function assertSourcePin(source, pin) {
  if (digest(source) !== pin) throw Error("SOURCE_REVIEW_REQUIRED");
}
function split(t, delimiter) {
  const parts = [];
  let start = 0,
    depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    if (t[i] === ")") depth--;
    if (!depth && t[i] === delimiter) {
      parts.push(t.slice(start, i));
      start = i + 1;
    }
  }
  if (start < t.length) parts.push(t.slice(start));
  return parts;
}
function group(t, start) {
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === "(") depth++;
    if (t[i] === ")" && --depth === 0) return [t.slice(start + 1, i), i + 1];
  }
  throw Error("UNSUPPORTED_DDL_GROUP");
}
const typeName = (s) => s.replaceAll("timestamp with time zone", "timestamptz");
function column(t) {
  const name = t.shift(),
    type = t.shift();
  if (
    ![
      "uuid",
      "text",
      "bigint",
      "integer",
      "boolean",
      "timestamptz",
      "jsonb",
      "bytea",
    ].includes(type)
  )
    throw Error("UNSUPPORTED_COLUMN_TYPE");
  const d = t.indexOf("default");
  let defaultValue = null;
  if (d >= 0) {
    let end = d + 1,
      depth = 0;
    for (; end < t.length; end++) {
      if (
        !depth &&
        ["check", "unique", "references", "not", "primary"].includes(t[end])
      )
        break;
      if (t[end] === "(") depth++;
      if (t[end] === ")") depth--;
    }
    defaultValue = sql(t.slice(d + 1, end));
  }
  return {
    name,
    type,
    nullable: !/not null|primary key/.test(sql(t)),
    default: defaultValue,
    identity: "",
    generated: "",
    collation: ["text"].includes(type) ? "pg_catalog.default" : null,
  };
}
// Source expressions and catalog expressions are compared conservatively. A
// rendering we cannot prove equal blocks; parentheses/casts are never discarded.
export const expression = expressionContract;
function addConstraint(table, t, columnName) {
  let name = null;
  if (t[0] === "constraint") {
    name = t[1];
    t = t.slice(2);
  }
  const kind = t[0];
  let columns = [],
    definition;
  if (kind === "check") {
    const [body] = group(t, 1);
    definition = `check ( ${sql(body)} )`;
  } else if (["primary", "unique", "foreign", "references"].includes(kind)) {
    let end = kind === "primary" || kind === "foreign" ? 2 : 1;
    if (columnName) columns = [columnName];
    else {
      const [body, next] = group(t, end);
      columns = split(body, ",").map(sql);
      end = next;
    }
    if (kind === "foreign" || kind === "references") {
      const ref = kind === "references" ? 1 : end + 1;
      const target = t.slice(ref, ref + 3).join("");
      let referenced = [];
      if (t[ref + 3] === "(")
        referenced = split(group(t, ref + 3)[0], ",").map(sql);
      definition = { target, columns: referenced };
    } else definition = null;
  } else throw Error("UNSUPPORTED_CONSTRAINT");
  table.constraints.push({
    name,
    kind: kind === "references" ? "foreign" : kind,
    columns,
    definition,
    validated: true,
    deferrable: false,
    deferred: false,
  });
}
function addColumn(table, t) {
  table.columns.push(column([...t]));
  const col = t[0];
  for (let i = 2; i < t.length; i++) {
    if (t[i] === "check") {
      const [, end] = group(t, i + 1);
      addConstraint(table, t.slice(i, end), col);
      i = end - 1;
    } else if (["primary", "unique", "references"].includes(t[i])) {
      addConstraint(table, t.slice(i), col);
      if (t[i] === "references") break;
      if (t[i] === "primary") i++;
    }
  }
}
function tableDDL(t, tables) {
  const name = t.slice(2, 5).join("");
  const table = {
    name,
    owner: "postgres",
    rls: name !== "app_private.account_policy" && name !== "auth.users",
    forceRls: false,
    columns: [],
    constraints: [],
  };
  for (const part of split(group(t, 5)[0], ",")) {
    if (
      ["constraint", "primary", "unique", "foreign", "check"].includes(part[0])
    )
      addConstraint(table, part);
    else addColumn(table, part);
  }
  tables.set(name, table);
}
function triggerDDL(t, triggers) {
  const on = t.indexOf("on"),
    name = t[2],
    table = t.slice(on + 1, on + 4).join("");
  triggers.set(`${table}.${name}`, {
    table,
    name,
    enabled: "O",
    definition: canonical(sql(t)),
  });
}
const ordinary = [
  "ss_bootstrap",
  "ss_account",
  "ss_list_files",
  "ss_file",
  "ss_edit_file",
  "ss_delete_file",
  "ss_reserve",
  "ss_sessions",
  "ss_allocate_attempt",
  "ss_cancel",
];
const readable = [
  "profiles",
  "files",
  "user_usage",
  "upload_sessions",
  "file_blocks",
  "transfer_attempts",
  "file_manifests",
  "usage_events",
];
export async function buildPredecessorContracts() {
  const pins = JSON.parse(
    await fs.readFile(
      path.join(root, "scripts/predecessor-contract-sources.json"),
      "utf8",
    ),
  );
  const sources = new Map();
  for (const [file, pin] of Object.entries(pins)) {
    const raw = await fs.readFile(path.join(root, file), "utf8");
    assertSourcePin(raw, pin);
    sources.set(file, raw);
  }
  const reconstructed = await reconstructFunctions();
  // The customized disposable bootstrap supplies auth.users and its two invoker
  // identity helpers; these are not Supabase-managed cloud objects here.
  for (const m of sources
    .get("scripts/prepare-disposable-browser-database.mjs")
    .matchAll(/CREATE FUNCTION (auth\.\w+)\([\s\S]*?AS (\$\$)([\s\S]*?)\2;/g)) {
    reconstructed.set(m[1], { body: m[3], definition: m[0], patches: [] });
  }
  const tables = new Map(),
    triggers = new Map(),
    indexes = [],
    statements = [];
  tableDDL(lex("create table auth.users (id uuid primary key)"), tables);
  for (const [file, raw] of sources) {
    if (!file.endsWith(".sql") || /001[234]_/.test(file)) continue;
    const top = split(lex(raw.replace(/^\uFEFF/, "")), ";");
    for (const t of top) {
      const s = sql(t);
      statements.push(s);
      if (s.startsWith("create table ")) tableDDL(t, tables);
      else if (s.startsWith("create trigger ")) triggerDDL(t, triggers);
      else if (/^create (unique )?index /.test(s)) {
        const on = t.indexOf("on");
        indexes.push({
          name: t[t.indexOf("index") + 1],
          table: t.slice(on + 1, on + 4).join(""),
          definition: s,
          valid: true,
          ready: true,
          live: true,
          replica: false,
        });
      } else if (s.startsWith("drop trigger "))
        triggers.delete(`${t.slice(4, 7).join("")}.${t[2]}`);
      else if (s.startsWith("alter table ")) {
        const table = tables.get(t.slice(2, 5).join(""));
        if (!table) throw Error("UNKNOWN_ALTER_TABLE");
        if (t[5] === "add" && t[6] === "constraint")
          addConstraint(table, t.slice(6));
        else if (t[5] === "add" && t[6] === "column")
          addColumn(table, t.slice(7));
        else if (
          t[5] === "alter" &&
          t[6] === "column" &&
          sql(t.slice(8)) === "drop not null"
        )
          table.columns.find((c) => c.name === t[7]).nullable = true;
        else if (t[5] === "drop" && t[6] === "constraint") {
          if (t[7] === "profiles_id_fkey")
            table.constraints = table.constraints.filter(
              (c) => c.kind !== "foreign",
            );
          else if (t[7] === "gateway_requests_slot_held_check")
            table.constraints = table.constraints.filter(
              (c) => c.definition !== "check ( slot_held )",
            );
          else throw Error("UNSUPPORTED_CONSTRAINT_DROP");
        } else if (sql(t.slice(5)) !== "enable row level security")
          throw Error("UNSUPPORTED_TABLE_ALTER");
      }
      // Only reviewed literal table loops; never evaluate arbitrary DO code.
      if (t[0] === "do") {
        const body = t.find((x) => x.startsWith("$"));
        const loop = body?.match(
          /foreach t in array array\[([\s\S]*?)\] loop([\s\S]*?)end loop;/i,
        );
        if (loop) {
          const names = [...loop[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
          for (const match of loop[2].matchAll(
            /execute format\('((?:''|[^'])*)',t\);/g,
          )) {
            const template = match[1].replaceAll("''", "'");
            for (const name of names) {
              const expanded = lex(template.replace("%I", name));
              if (expanded[0] === "create" && expanded[1] === "trigger")
                triggerDDL(expanded, triggers);
            }
          }
        }
      }
    }
  }
  // Resolve omitted FK target columns to the referenced primary key.
  for (const table of tables.values())
    table.columns.forEach((c, i) => {
      c.position = i + 1;
    });
  for (const table of tables.values())
    for (const c of table.constraints) {
      if (c.kind === "foreign" && !c.definition.columns.length) {
        c.definition.columns = tables
          .get(c.definition.target)
          ?.constraints.find((x) => x.kind === "primary")?.columns;
        if (!c.definition.columns) throw Error("UNRESOLVED_FOREIGN_KEY");
      }
    }
  const functions = [];
  for (const [name, expected] of reconstructed) {
    const header = expected.definition.slice(
      0,
      expected.definition.search(/\bas\s+\$/i),
    );
    const t = lex(header),
      start = t.indexOf("("),
      [args] = group(t, start);
    const argumentsList = split(args, ",").map((a) =>
      sql(
        a.slice(0, a.indexOf("default") < 0 ? a.length : a.indexOf("default")),
      ),
    );
    const returns = t.indexOf("returns"),
      language = t.indexOf("language");
    const grants = ordinary.includes(name.split(".")[1])
      ? ["authenticated"]
      : name === "public.ss_expire"
        ? ["service_role"]
        : name === "app_private.actor"
          ? ["authenticated"]
          : [];
    // Explicit top-level GRANTs are replayed in source order. Legacy loop grants
    // are enumerated above; migration 010 retires the other six legacy RPCs.
    for (const s of statements) {
      const m = s.match(/^grant execute on function ([\s\S]+) to ([\s\S]+)$/);
      if (m && m[1].includes(canonical(name) + " ("))
        grants.push(...m[2].split(" , "));
    }
    const security = {
      contractVersion: 1,
      arguments: argumentsList.join(", "),
      proowner: "postgres",
      prosecdef:
        /security definer/i.test(header) ||
        name === "app_private.gateway_identity_guard",
      proconfig: name.startsWith("auth.") ? null : ['search_path=""'],
      result: sql(t.slice(returns + 1, language)),
      language: t[language + 1],
      volatility: t.includes("immutable")
        ? "i"
        : t.includes("stable")
          ? "s"
          : "v",
      strict: false,
      leakproof: false,
      parallel: "u",
      cost: 100,
      rows: 0,
      support: "-",
      defaults: split(args, ",")
        .filter((a) => a.includes("default"))
        .map((a) => sql(a.slice(a.indexOf("default") + 1))),
      execute: name.startsWith("auth.")
        ? ["PUBLIC"]
        : [...new Set(grants)].sort(),
    };
    functions.push({ name, ...expected, security });
  }
  const policies = readable.map((name) => ({
    table: `public.${name}`,
    name: name === "profiles" ? "profile_read" : "owner_read",
    permissive: "PERMISSIVE",
    roles: ["authenticated"],
    command: "SELECT",
    using:
      name === "profiles"
        ? "id = (select app_private.actor())"
        : "owner_id = (select app_private.actor())",
    check: null,
  }));
  const restricted = [
    "ss_gateway_executor",
    "ss_gateway_observer",
    "ss_gateway_finalizer",
    "ss_gateway_cleaner",
    "ss_volume_gateway",
    "ss_volume_runtime",
  ];
  const roles = [
    "postgres",
    "anon",
    "authenticated",
    "service_role",
    ...restricted,
  ].map((name) => ({
    name,
    login: ["postgres", "ss_volume_runtime"].includes(name),
    super: name === "postgres",
    inherit: !restricted.includes(name),
    bypass: ["postgres", "service_role"].includes(name),
    createRole: name === "postgres",
    createDb: name === "postgres",
    replication: name === "postgres",
  }));
  return {
    version: 1,
    pins,
    tables: [...tables.values()],
    indexes,
    triggers: [...triggers.values()],
    functions,
    policies,
    roles,
    memberships: [
      {
        role: "ss_volume_gateway",
        member: "ss_volume_runtime",
        admin: false,
        inherit: false,
        set: true,
      },
    ],
    readable: readable.map((n) => `public.${n}`),
    absent: {
      relations: ["prepared_block_bindings", "prepared_block_plans"],
      functions: [
        "prepared_binding_immutable",
        "ss_prepared_block_resolve_v1",
        "ss_prepared_block_dispatch_v1",
        "ss_prepared_manifest_register_v1",
        "ss_registered_block_resolve_v1",
        "ss_registered_block_dispatch_v1",
      ],
      triggers: ["prepared_binding_immutable", "prepared_plan_immutable"],
    },
    invariants: {
      reservationQuota: [
        "public.ss_reserve",
        "app_private.gateway_enroll_reservation",
        "app_private.gateway_lock_session",
      ],
      dispatch: [
        "app_private.gateway_lock_attempt",
        "public.ss_gateway_claim_v1",
        "public.ss_gateway_register_resource_v1",
        "public.ss_gateway_dispatch_v1",
        "public.ss_gateway_resolve_dispatch_v1",
      ],
      immutableState: [
        "app_private.owner_immutable",
        "app_private.file_transition",
        "app_private.attempt_counters",
        "app_private.gateway_identity_guard",
        "app_private.gateway_request_transition",
        "app_private.gateway_evidence_immutable",
        "app_private.volume_object_transition",
        "app_private.volume_no_alternate_writer",
      ],
      settlement: [
        "app_private.gateway_check_membership",
        "app_private.gateway_check_verification",
        "app_private.gateway_lock_cleanup",
        "public.ss_gateway_settle_cleanup_v1",
        "public.ss_volume_command",
      ],
      provisioning: [
        "app_private.provision_local_account",
        "public.ss_volume_command",
      ],
    },
  };
}

export function contractManifest(c) {
  return {
    ...c,
    functions: c.functions.map(({ name, body, patches, security }) => ({
      name,
      bodySha256: digest(body),
      patches,
      security,
    })),
  };
}
export async function loadPredecessorContracts() {
  const contract = await buildPredecessorContracts();
  const reviewed = JSON.parse(
    await fs.readFile(
      path.join(root, "scripts/predecessor-contracts.json"),
      "utf8",
    ),
  );
  if (!equal(contractManifest(contract), reviewed))
    throw Error("CONTRACT_REVIEW_REQUIRED");
  return contract;
}

// Exact sets (including duplicates) are intentional: extra policies, grants,
// overloads, triggers or constraints can change authorization and must block.
function sorted(values) {
  return values.map((v) => JSON.stringify(stable(v))).sort();
}
export function comparePredecessorCatalog(contract, catalog) {
  try {
    return compareCatalog(contract, catalog);
  } catch {
    return { status: "BLOCKED", checks: { malformedEvidence: "BLOCKED" } };
  }
}
function compareCatalog(contract, catalog) {
  const checks = {};
  const diagnostics = {};
  const check = (name, ok) => {
    checks[name] = ok === true ? "PASS" : "BLOCKED";
  };
  if (!catalog || catalog.version !== 1)
    return { status: "BLOCKED", checks: { evidence: "BLOCKED" } };
  const set = (name, expected, actual) => {
    if (["constraints", "triggers", "ACLs"].includes(name))
      diagnostics[name] = diagnoseObjects(name, expected, actual);
    check(
      name,
      Array.isArray(actual) && equal(sorted(expected), sorted(actual)),
    );
  };
  set("roles", contract.roles, catalog.roles);
  set("memberships", contract.memberships, catalog.memberships);
  set("defaultACLs", [], catalog.defaultACLs);
  set(
    "roleSettings",
    [
      {
        role: "ss_volume_runtime",
        database: "smart_storage_gateway_test",
        config: ['search_path=""'],
      },
    ],
    catalog.roleSettings,
  );
  check(
    "migrationObjectsAbsent",
    ["relations", "functions", "triggers"].every(
      (k) =>
        Array.isArray(catalog.names?.[k]) &&
        !contract.absent[k].some((n) => catalog.names[k].includes(n)),
    ),
  );
  set(
    "tables",
    contract.tables.map(({ name, owner, rls, forceRls }) => ({
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
    })),
    catalog.tables,
  );
  set(
    "columns",
    contract.tables.flatMap((t) =>
      t.columns.map((c) => ({
        table: t.name,
        ...c,
        default: expression(c.default),
      })),
    ),
    catalog.columns?.map((c) => ({
      ...c,
      type: typeName(c.type),
      default: expression(c.default),
    })),
  );
  const constraints = contract.tables.flatMap((t) =>
    t.constraints.map((c) => ({ table: t.name, ...c })),
  );
  // Autogenerated constraint names are not authorization; explicit names remain fenced.
  const shape = (c) => ({
    table: c.table,
    kind: c.kind,
    columns: c.columns,
    definition:
      typeof c.definition === "string"
        ? expression(c.definition)
        : c.definition,
    validated: c.validated,
    deferrable: c.deferrable,
    deferred: c.deferred,
    // NO INHERIT is a source-level option only for CHECK constraints; PostgreSQL
    // marks primary/unique/FK constraints noninheritable internally by default.
    noInherit: c.kind === "check" ? c.noInherit : null,
    foreignActions: c.kind === "foreign" ? c.foreignActions : null,
  });
  for (const c of constraints) {
    c.noInherit = false;
    if (c.kind === "foreign") c.foreignActions = "aas";
  }
  set("constraints", constraints.map(shape), catalog.constraints?.map(shape));
  check(
    "namedConstraints",
    Array.isArray(catalog.constraints) &&
      constraints
        .filter((c) => c.name)
        .every((c) =>
          catalog.constraints.some(
            (r) => r.name === c.name && equal(shape(c), shape(r)),
          ),
        ),
  );
  const idx = (i) => {
    const t = lex(i.definition),
      where = t.indexOf("where");
    return {
      ...i,
      definition:
        where < 0
          ? canonical(i.definition)
          : sql(t.slice(0, where)) +
            " where " +
            expression(sql(t.slice(where + 1))),
    };
  };
  set("indexes", contract.indexes.map(idx), catalog.indexes?.map(idx));
  check("constraintIndexes", catalog.constraintIndexesValid === true);
  const trg = (t) => ({ ...t, definition: triggerContract(t.definition) });
  set("triggers", contract.triggers.map(trg), catalog.triggers?.map(trg));
  const pol = (p) => ({
    ...p,
    using: expression(p.using),
    check: expression(p.check),
  });
  set("policies", contract.policies.map(pol), catalog.policies?.map(pol));
  check(
    "functionInventory",
    Array.isArray(catalog.functions) &&
      equal(
        sorted(contract.functions.map((f) => f.name)),
        sorted(catalog.functions.map((f) => f.name)),
      ),
  );
  check(
    "functions",
    contract.functions.every(
      (f) =>
        compareFunction(
          f,
          catalog.functions?.filter((r) => r.name === f.name) ?? [],
          f.security,
        ).status === "PASS",
    ),
  );
  // ACLs are expanded by aclexplode in the read-only evidence query. Function
  // PUBLIC defaults are expanded even if proacl is NULL; grant options matter.
  const grants = [];
  const add = (
    kind,
    object,
    grantee,
    privilege,
    grantable = false,
    grantor = "postgres",
  ) => grants.push({ kind, object, grantee, privilege, grantable, grantor });
  for (const t of contract.tables) {
    for (const privilege of [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ])
      add("table", t.name, "postgres", privilege);
    if (contract.readable.includes(t.name))
      add("table", t.name, "authenticated", "SELECT");
  }
  for (const f of contract.functions) {
    add("function", f.name, "postgres", "EXECUTE");
    for (const role of f.security.execute)
      add("function", f.name, role, "EXECUTE");
  }
  for (const schema of ["app_private", "auth"])
    for (const privilege of ["USAGE", "CREATE"])
      add("schema", schema, "postgres", privilege);
  add("schema", "app_private", "authenticated", "USAGE");
  for (const role of ["anon", "authenticated", "service_role"])
    add("schema", "auth", role, "USAGE");
  for (const privilege of ["USAGE", "CREATE"])
    add(
      "schema",
      "public",
      "pg_database_owner",
      privilege,
      false,
      "pg_database_owner",
    );
  add("schema", "public", "PUBLIC", "USAGE", false, "pg_database_owner");
  for (const role of contract.roles.filter(
    (r) => r.name.startsWith("ss_gateway_") || r.name === "ss_volume_gateway",
  ))
    add("schema", "public", role.name, "USAGE");
  set("ACLs", grants, catalog.grants);
  // Expected matrix covers every non-superuser application role and every
  // protected object/operation, independently of raw ACL representation.
  const effective = [];
  for (const role of contract.roles.filter((r) => !r.super)) {
    for (const t of contract.tables)
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ])
        effective.push({
          role: role.name,
          kind: "table",
          object: t.name,
          privilege,
          allowed:
            role.name === "authenticated" &&
            contract.readable.includes(t.name) &&
            privilege === "SELECT",
        });
    for (const f of contract.functions)
      effective.push({
        role: role.name,
        kind: "function",
        object: f.name,
        privilege: "EXECUTE",
        allowed:
          f.security.execute.includes(role.name) ||
          f.security.execute.includes("PUBLIC"),
      });
    for (const schema of ["public", "app_private", "auth"])
      for (const privilege of ["USAGE", "CREATE"])
        effective.push({
          role: role.name,
          kind: "schema",
          object: schema,
          privilege,
          allowed:
            privilege === "USAGE" &&
            (schema === "public" ||
              (schema === "app_private" && role.name === "authenticated") ||
              (schema === "auth" &&
                ["anon", "authenticated", "service_role"].includes(role.name))),
        });
  }
  set("effectivePrivileges", effective, catalog.effectivePrivileges);
  check(
    "columnACLs",
    Array.isArray(catalog.columnACLs) && catalog.columnACLs.length === 0,
  );
  check(
    "schemaOwners",
    equal(catalog.schemaOwners, {
      public: "pg_database_owner",
      app_private: "postgres",
      auth: "postgres",
    }),
  );
  check("databaseBoundary", catalog.databaseBoundary === true);
  check(
    "otherObjects",
    Array.isArray(catalog.otherObjects) && catalog.otherObjects.length === 0,
  );
  check("routineKinds", catalog.routineKindsValid === true);
  check(
    "rewriteRules",
    Array.isArray(catalog.rewriteRules) && catalog.rewriteRules.length === 0,
  );
  check(
    "eventTriggers",
    Array.isArray(catalog.eventTriggers) && catalog.eventTriggers.length === 0,
  );
  const status = Object.values(checks).every((s) => s === "PASS")
    ? "PASS"
    : "BLOCKED";
  // These are catalog/source invariants, never claims of native race/crash proof.
  return {
    status,
    checks,
    diagnostics,
    invariants: Object.fromEntries(
      Object.keys(contract.invariants).map((name) => [name, status]),
    ),
  };
}
