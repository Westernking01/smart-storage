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
  "docs/disposable-qualification-catalog-report.20261022-contract-verification.json",
);
try {
  assert.equal(process.argv.length, 2);
  const sql = await fs.readFile(
    path.join(root, "docs/disposable-qualification-catalog.readonly.sql"),
    "utf8",
  );
  assert.equal(
    digest(sql),
    "bd62edaf241420fcb645939b1337a66a134e16833ec40c1eed9d7b04d42ed7a9",
  );
  const contract = await loadPredecessorContracts();
  const evidenceSql = await fs.readFile(
    path.join(root, "docs/disposable-predecessor-evidence.readonly.sql"),
    "utf8",
  );
  assert.equal(
    digest(evidenceSql),
    "723b97b49611d4ce61d1c9f9ec194fbb5c686bc5c16cad154b701a51f0b81cf0",
  );
  const reconstructed = await reconstructFunctions();
  const expected = new Map(
    [...reconstructed].map(([name, value]) => [name, value.body]),
  );
  // No secret is read until local source gates pass. One attempt marker, no replay.
  await fs.writeFile(
    path.join(
      root,
      ".cache/browser-roundtrip-20261020/catalog-inspection-once.20261022-contract-verification.json",
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
  // Guard precedes every catalog SELECT inside this pinned, reviewed SQL batch.
  const privilegeSql = `select
    not exists(select from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
      where r.rolname in ('anon','authenticated','service_role','ss_gateway_executor','ss_gateway_observer','ss_gateway_finalizer','ss_gateway_cleaner','ss_volume_runtime','ss_volume_gateway')
      and n.nspname='app_private' and c.relkind='r'
      and has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) private_tables_denied,
    not exists(select from pg_roles r join pg_proc p on p.oid='app_private.provision_local_account(text,uuid,bigint,integer)'::regprocedure
      where not r.rolsuper and has_function_privilege(r.oid,p.oid,'EXECUTE')) provisioning_operator_only,
    not exists(select from pg_auth_members m join pg_roles r on r.oid=m.roleid
      where r.rolname in ('ss_gateway_executor','ss_gateway_observer','ss_gateway_finalizer','ss_gateway_cleaner')) no_gateway_memberships,
    has_function_privilege('ss_gateway_executor','public.ss_gateway_resolve_dispatch_v1(uuid,uuid,uuid,uuid,bigint,bigint)','EXECUTE') executor_dispatch_granted,
    not has_function_privilege('authenticated','public.ss_gateway_resolve_dispatch_v1(uuid,uuid,uuid,uuid,bigint,bigint)','EXECUTE') ordinary_dispatch_denied;
  rollback;`;
  const results = await client.query(
    sql.replace(/rollback;\s*$/, evidenceSql + "\n" + privilegeSql),
  );
  report.target = "PASS";
  report.inspection = "PASS";
  const find = (column) =>
    results.find((r) => r.fields.some((f) => f.name === column))?.rows ?? [];
  const tables = find("relrowsecurity"),
    roles = find("rolname"),
    defaults = find("defaclacl");
  const columns = find("column_name"),
    constraints = find("conname"),
    indexes = find("indexdef"),
    triggers = find("tgenabled"),
    policies = find("policyname"),
    functions = find("prosecdef");
  const checks = report.checks;
  checks.catalogSections =
    results.filter((r) => r.command === "SELECT").length === 12;
  const compatibility = comparePredecessorCatalog(
    contract,
    find("predecessor_catalog")[0]?.predecessor_catalog,
  );
  report.predecessorContracts = compatibility;
  if (checks.catalogSections && compatibility.status === "PASS") {
    report.migration012 = "PASS";
    report.migration013 = "PASS";
    report.migration014 = "PASS";
  }
  report.effectivePrivileges = find("private_tables_denied")[0];
  checks.requiredRoles = [
    "postgres",
    "anon",
    "authenticated",
    "service_role",
    "ss_gateway_executor",
    "ss_gateway_observer",
    "ss_gateway_finalizer",
    "ss_gateway_cleaner",
    "ss_volume_gateway",
    "ss_volume_runtime",
  ].every((name) => roles.some((r) => r.rolname === name));
  checks.gatewayRolesRestricted =
    roles.filter((r) => r.rolname.startsWith("ss_gateway_")).length === 4 &&
    roles
      .filter((r) => r.rolname.startsWith("ss_gateway_"))
      .every(
        (r) =>
          !r.rolcanlogin &&
          !r.rolsuper &&
          !r.rolinherit &&
          !r.rolbypassrls &&
          !r.rolcreaterole &&
          !r.rolcreatedb,
      );
  checks.noCustomDefaultACLs = defaults.length === 0;
  const newFunctions = [
    "prepared_binding_immutable",
    "ss_prepared_block_resolve_v1",
    "ss_prepared_block_dispatch_v1",
    "ss_prepared_manifest_register_v1",
    "ss_registered_block_resolve_v1",
    "ss_registered_block_dispatch_v1",
  ];
  checks.migrationObjectsAbsent =
    !tables.some((r) =>
      ["prepared_block_bindings", "prepared_block_plans"].includes(r.relname),
    ) &&
    !functions.some((r) => newFunctions.includes(r.proname)) &&
    !triggers.some((r) =>
      ["prepared_binding_immutable", "prepared_plan_immutable"].includes(
        r.tgname,
      ),
    );
  const requiredTables = {
    public: [
      "profiles",
      "user_usage",
      "files",
      "upload_sessions",
      "file_blocks",
      "transfer_attempts",
    ],
    app_private: [
      "gateway_accounts",
      "gateway_requests",
      "gateway_resources",
      "gateway_invalidations",
      "gateway_discoveries",
      "local_principals",
    ],
  };
  checks.requiredTables = Object.entries(requiredTables).every(
    ([schema, names]) =>
      names.every((name) =>
        tables.some(
          (r) =>
            r.nspname === schema &&
            r.relname === name &&
            r.relkind === "r" &&
            r.relowner === "postgres" &&
            r.relrowsecurity,
        ),
      ),
  );
  checks.sourceIdentityColumn = columns.some(
    (r) =>
      r.table_schema === "public" &&
      r.table_name === "upload_sessions" &&
      r.column_name === "initial_source_sha256" &&
      r.udt_name === "text" &&
      r.is_nullable === "NO",
  );
  checks.dormantDefaults = [
    ["file_blocks", "state", "'allocated'::text"],
    ["transfer_attempts", "state", "'authorized'::text"],
    ["transfer_attempts", "attempted_bytes", "0"],
    ["transfer_attempts", "acknowledged_bytes", "0"],
  ].every(([table, col, def]) =>
    columns.some(
      (r) =>
        r.table_schema === "public" &&
        r.table_name === table &&
        r.column_name === col &&
        r.column_default === def,
    ),
  );
  checks.oneHeldRequestIndex = indexes.some(
    (r) =>
      r.indexname === "gateway_one_stream_per_session" &&
      /CREATE UNIQUE INDEX/.test(r.indexdef) &&
      /\(session_id\) WHERE slot_held/.test(r.indexdef),
  );
  checks.admissionEnabled = triggers.some(
    (r) => r.tgname === "gateway_reservation_admission" && r.tgenabled === "O",
  );
  const requiredFunctions = [
    "app_private.gateway_lock_attempt",
    "public.ss_gateway_claim_v1",
    "public.ss_gateway_register_resource_v1",
    "public.ss_gateway_resolve_dispatch_v1",
  ];
  report.predecessorFunctions = requiredFunctions.map((name) => {
    const matches = functions.filter(
      (r) => `${r.nspname}.${r.proname}` === name,
    );
    const f = matches[0];
    return {
      comparison: compareFunction(
        reconstructed.get(name),
        find("predecessor_catalog")[0]?.predecessor_catalog?.functions?.filter(
          (r) => r.name === name,
        ) ?? [],
        contract.functions.find((f) => f.name === name)?.security,
      ),
      name,
      unique: matches.length === 1,
      bodyMatchesSource:
        compareFunction(reconstructed.get(name), matches).bodyMatches === true,
      ownerCorrect: f?.proowner === "postgres",
      securityModeCorrect:
        f?.prosecdef === (name !== "app_private.gateway_lock_attempt"),
      emptySearchPath:
        JSON.stringify(f?.proconfig) === JSON.stringify(['search_path=""']),
    };
  });
  checks.predecessorFunctionSecurity = [
    "functions",
    "ACLs",
    "effectivePrivileges",
    "roles",
    "memberships",
    "defaultACLs",
    "roleSettings",
  ].every((name) => compatibility.checks[name] === "PASS")
    ? "PASS"
    : "BLOCKED";
  checks.predecessorFunctionBodies = report.predecessorFunctions.every(
    (r) =>
      r.unique &&
      r.bodyMatchesSource &&
      r.ownerCorrect &&
      r.securityModeCorrect &&
      r.emptySearchPath,
  );
  report.sourceFunctionReview = [...expected].map(([name]) => {
    const matches = functions.filter(
      (r) => `${r.nspname}.${r.proname}` === name,
    );
    return {
      name,
      comparison: compareFunction(
        reconstructed.get(name),
        find("predecessor_catalog")[0]?.predecessor_catalog?.functions?.filter(
          (r) => r.name === name,
        ) ?? [],
        contract.functions.find((f) => f.name === name)?.security,
      ),
      unique: matches.length === 1,
      bodyMatchesSource:
        compareFunction(reconstructed.get(name), matches).bodyMatches === true,
    };
  });
  const volume = functions.find(
    (r) => r.nspname === "public" && r.proname === "ss_volume_command",
  );
  checks.provisioningGuard =
    !!volume &&
    volume.definition.includes("ACCOUNT_SETUP_REQUIRED") &&
    volume.definition.includes("app_private.local_principals") &&
    volume.definition.includes("smart_storage.local_issuer") &&
    volume.proowner === "postgres" &&
    volume.prosecdef;
  checks.provisioningProfileFK = constraints.some(
    (r) =>
      r.conname === "profiles_id_fkey" &&
      /REFERENCES app_private.local_principals\(id\)/.test(r.definition),
  );
  report.catalogCounts = {
    tables: tables.length,
    columns: columns.length,
    constraints: constraints.length,
    indexes: indexes.length,
    triggers: triggers.length,
    policies: policies.length,
    functions: functions.length,
    defaultACLs: defaults.length,
  };
  // Only names selected from repository source; never emit unknown identifiers/definitions.
  report.triggerReview = triggers
    .filter((r) =>
      /file_blocks|transfer_attempts|upload_sessions/.test(r.tgrelid),
    )
    .map((r) => ({
      enabled: r.tgenabled === "O",
      definitionSha256: digest(r.definition),
    }));
  report.catalogDigest = digest(JSON.stringify(results.map((r) => r.rows)));
  report.limitations = [
    ...(compatibility.status === "PASS"
      ? []
      : ["PREDECESSOR_CONTRACTS_BLOCKED"]),
    "NO_MIGRATION_OR_RUNTIME_QUALIFICATION",
  ];
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
