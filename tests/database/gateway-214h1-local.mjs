// Local PostgreSQL only; never reads credentials or replays historical harnesses.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
env.PGCONNECT_TIMEOUT = "3";
const exe = "C:/Program Files/PostgreSQL/17/bin/psql.exe";
const args = [
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
];
const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const run = (sql, expected) => {
  const r = spawnSync(exe, args, {
    env,
    input: sql,
    encoding: "utf8",
    timeout: 15000,
  });
  if (expected) {
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(expected), r.stderr);
    return;
  }
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr);
  return r.stdout.trim();
};
const check = (sql) => assert.equal(run(sql), "t", sql);
check(
  "begin read only; select current_database()='smart_storage_gateway_test' and current_setting('server_version')='17.11' and current_user='postgres'; rollback;",
);
const inventory = JSON.parse(
  readFileSync("tests/database/gateway-214e-inventory.json", "utf8"),
);
// No migration-history table was created by 2.14E: require retained installation
// evidence plus every retained relation/function (including 001-007 contracts).
const prior = JSON.parse(
  readFileSync("tests/database/gateway-214e-results.json", "utf8"),
);
assert.equal(prior.migrations.length, 7);
assert.equal(prior.status, "COMPLETE");
check(
  `begin read only; select ${inventory.relations
    .map((x) => `to_regclass(${quote(x.schema + "." + x.name)}) is not null`)
    .concat(
      inventory.functions.map(
        (x) => `to_regprocedure(${quote(x.signature)}) is not null`,
      ),
    )
    .join(" and ")}; rollback;`,
);
const migration =
  "supabase/migrations/202610160008_gateway_write_observations.sql";
const signature =
  "public.ss_gateway_record_write_observation_v1(uuid,uuid,uuid,uuid,bigint,uuid,jsonb)";
const receiptSQL = () =>
  run(
    "begin read only; select pg_get_functiondef('public.ss_gateway_record_receipt_v1(uuid,uuid,uuid,bigint,jsonb)'::regprocedure); rollback;",
  );
const receiptBefore = receiptSQL();
if (process.argv[2] === "--apply") {
  check(
    "begin read only; select not exists(select from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ss_gateway_record_write_observation_v1') and not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relname in ('gateway_write_observations','gateway_write_observations_pkey','gateway_write_observations_operation_key_key')); rollback;",
  );
  run(readFileSync(migration, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(receiptSQL(), receiptBefore);
  console.log(
    "PASS preflight and migration 008; existing receipt function unchanged",
  );
  process.exit(0);
}
assert.equal(process.argv[2], "--test");
check(`select to_regprocedure(${quote(signature)}) is not null;`);
const namespace = randomUUID().slice(0, 8);
const id = (p, k = 1) =>
  `${p}${namespace.slice(1)}-2148-4000-8000-${String(k).padStart(12, "0")}`;
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
const owner = id(0),
  request = id(5),
  resource = id(7),
  executor = id(6),
  session = id(2);
run(`begin; ${fixture} commit;`);
const scope = {
  namespace: "local-214h1-" + namespace,
  uploadId: null,
  version: null,
  generation: null,
};
const path = run(
  `select object_path from public.transfer_attempts where id='${id(4)}';`,
);
run(`begin; set local role ss_gateway_executor;
select public.ss_gateway_claim_v1('${owner}','${id(4)}','${request}',8,'${executor}');
select public.ss_gateway_register_resource_v1('${owner}','${request}','${resource}',1,'object',${quote(path)},${quote(JSON.stringify(scope))}::jsonb,8);
select public.ss_gateway_dispatch_v1('${owner}','${request}','${executor}',1); commit;`);
const base = {
  classification: "provisional",
  intent: {
    ownerId: owner,
    requestId: request,
    resourceId: resource,
    executorId: executor,
    dispatchGeneration: 1,
    epoch: 1,
    bucket: "local-gateway-test",
    path,
    sessionId: session,
    fileId: id(1),
    attemptId: id(4),
    declaredBytes: 8,
    expectedSha256: "a".repeat(64),
    operation: "single-object-create",
  },
  decisionId: request,
  writerId: executor,
  reservationId: session,
  exposureId: resource,
  startedAt: 1,
  finishedAt: 2,
  maximumEncodedBytes: 8,
  reservedExposureBytes: 8,
  state: "dispatch-intent",
  reason: "BEFORE_DISPATCH",
  inputBytes: 0,
  forwardedBytes: 0,
  sha256: null,
  digestComplete: false,
  response: null,
  evidencePersistence: "pending-durable-ack",
  futureProviderEffectsPossible: true,
  retainHolds: true,
  certified: false,
};
const call = (
  o = base,
  op = randomUUID(),
  own = owner,
  epoch = 1,
  res = resource,
  exec = executor,
) =>
  `select public.ss_gateway_record_write_observation_v1('${own}','${request}','${res}','${exec}',${epoch},'${op}',${quote(JSON.stringify(o))}::jsonb);`;
const invoke = (o, op, own, epoch, res, exec) =>
  run(
    `begin; set local role ss_gateway_executor; ${call(o, op, own, epoch, res, exec)} commit;`,
  );
const fail = (sql, error, role = "ss_gateway_executor") =>
  run(`begin; set local role ${role}; ${sql} rollback;`, error);
const passed = [];
const pass = (name) => {
  passed.push(name);
  console.log("PASS " + name);
};
check(
  `select p.prosecdef and p.proconfig=array['search_path=""']::text[] and pg_get_userbyid(p.proowner)='postgres' from pg_proc p where p.oid=${quote(signature)}::regprocedure;`,
);
check(
  `select c.relrowsecurity and pg_get_userbyid(c.relowner)='postgres' from pg_class c where c.oid='app_private.gateway_write_observations'::regclass;`,
);
for (const role of [
  "anon",
  "authenticated",
  "service_role",
  "ss_gateway_executor",
  "ss_gateway_observer",
  "ss_gateway_finalizer",
  "ss_gateway_cleaner",
]) {
  check(
    `select not has_table_privilege('${role}','app_private.gateway_write_observations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and has_function_privilege('${role}',${quote(signature)},'EXECUTE')=${role === "ss_gateway_executor"};`,
  );
}
pass("definer ownership, fixed search path, RLS and exact runtime grants");
const snapshot = () =>
  run(
    `select jsonb_build_array((select to_jsonb(u) from public.user_usage u where owner_id='${owner}'),(select to_jsonb(s) from public.upload_sessions s where id='${session}'),(select to_jsonb(q) from app_private.gateway_requests q where request_id='${request}'),(select count(*) from app_private.gateway_verifications),(select count(*) from app_private.gateway_stream_completions),(select count(*) from app_private.gateway_settlements));`,
  );
const before = snapshot();
const op = randomUUID();
const receipt = invoke(base, op);
pass("dispatch intent");
const response = {
  ...base,
  state: "response-observed",
  reason: "RESPONSE",
  inputBytes: 8,
  forwardedBytes: 8,
  sha256: "a".repeat(64),
  digestComplete: true,
  response: {
    kind: "response",
    status: 200,
    provenance: "authenticated-storage-response",
    requestId: null,
    version: null,
    etag: null,
    acknowledgedBytes: 8,
  },
};
invoke(response);
pass("write response remains provisional");
invoke({ ...base, state: "ambiguous", reason: "TIMEOUT" });
pass("timeout ambiguity");
invoke({ ...base, state: "ambiguous", reason: "SOURCE_ERROR" });
pass("non-timeout ambiguity");
assert.equal(invoke(base, op), receipt);
pass("exact duplicate idempotency");
fail(call({ ...base, reason: "CONFLICT" }, op), "IDEMPOTENCY_CONFLICT");
pass("conflicting duplicate");
for (const key of [
  "attemptId",
  "resourceId",
  "sessionId",
  "fileId",
  "ownerId",
  "path",
  "expectedSha256",
])
  fail(
    call({
      ...base,
      intent: {
        ...base.intent,
        [key]: key === "path" ? "wrong" : randomUUID(),
      },
    }),
    "IDENTITY_MISMATCH",
  );
fail(call(base, randomUUID(), owner, 1, randomUUID()), "RESOURCE_MISMATCH");
pass("wrong immutable identity");
fail(call(base, randomUUID(), owner, 2), "STALE_EPOCH");
pass("stale supplied epoch");
fail(call(base, randomUUID(), id(0, 2)), "FORBIDDEN");
fail(call(base, randomUUID(), owner, 1, resource, randomUUID()), "FORBIDDEN");
pass("cross-account and executor injection");
for (const role of [
  "anon",
  "authenticated",
  "service_role",
  "ss_gateway_observer",
  "ss_gateway_finalizer",
  "ss_gateway_cleaner",
])
  fail(call(), "permission denied", role);
pass("unauthorized roles");
for (const patch of [
  { certified: true },
  { retainHolds: false },
  { forwardedBytes: 9, inputBytes: 9 },
  { response: {} },
  { state: "inspection" },
  { startedAt: null },
  { sha256: "wrong" },
  { digestComplete: null },
])
  fail(call({ ...base, ...patch }), "INVALID_OBSERVATION");
pass("malformed and certification assertions rejected");
run(
  `begin; update app_private.gateway_write_observations set observation=observation where receipt_id='${receipt}'; rollback;`,
  "EVIDENCE_HISTORY_IMMUTABLE",
);
run(
  `begin; delete from app_private.gateway_write_observations where receipt_id='${receipt}'; rollback;`,
  "EVIDENCE_HISTORY_IMMUTABLE",
);
fail(
  "select * from app_private.gateway_write_observations;",
  "permission denied",
);
pass("append-only and private RLS boundary");
// Independent A/B/C connections with observed lock overlap before A commits.
const children = [];
function connect(label) {
  const c = spawn(exe, args, {
    env: { ...env, PGAPPNAME: `ss214h1_${namespace}_${label}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const x = { c, out: "", err: "", closed: false };
  c.stdout.on("data", (d) => (x.out += d));
  c.stderr.on("data", (d) => (x.err += d));
  c.on("close", () => (x.closed = true));
  children.push(x);
  return x;
}
async function until(fn) {
  const end = Date.now() + 12000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("overlap deadline");
    await delay(25);
  }
}
let overlap;
try {
  const a = connect("a"),
    b = connect("b");
  const concurrentKey = randomUUID();
  a.c.stdin.write(
    `begin; set local role ss_gateway_executor; ${call(base, concurrentKey)} select 'A_READY';\n`,
  );
  await until(() => a.out.includes("A_READY") || a.closed);
  assert.ok(!a.closed, a.err);
  b.c.stdin.write(
    `begin; set local role ss_gateway_executor; ${call({ ...base, reason: "CONCURRENT_CONFLICT" }, concurrentKey)} commit;\n`,
  );
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const rows = JSON.parse(
      run(
        `select coalesce(json_agg(json_build_object('a',a.pid,'b',b.pid,'c',pg_backend_pid(),'isolation',current_setting('transaction_isolation'),'wait',b.wait_event_type)),'[]') from pg_stat_activity a cross join pg_stat_activity b where a.application_name='ss214h1_${namespace}_a' and b.application_name='ss214h1_${namespace}_b' and a.pid=any(pg_blocking_pids(b.pid));`,
      ),
    );
    if (rows.length) {
      overlap = rows[0];
      break;
    }
    await delay(30);
  }
  assert.ok(overlap, "No genuine lock overlap");
  assert.equal(overlap.wait, "Lock");
  assert.equal(new Set([overlap.a, overlap.b, overlap.c]).size, 3);
  a.c.stdin.write("commit; select 'A_COMMITTED';\n");
  await until(() => a.out.includes("A_COMMITTED"));
  await until(() => b.closed);
  assert.ok(b.err.includes("IDEMPOTENCY_CONFLICT"), b.err);
  a.c.stdin.end();
  pass("independent concurrent conflict with observed lock wait");
} finally {
  for (const x of children) if (!x.closed) x.c.kill();
}
assert.equal(snapshot(), before);
pass("no certificate, completion, accounting or reservation mutation");
run(
  `begin; update public.upload_sessions set epoch=2 where id='${session}'; set local role ss_gateway_executor; ${call()} rollback;`,
  "STALE_EPOCH",
);
pass("database current epoch fences old writer");
assert.equal(receiptSQL(), receiptBefore);
pass("existing receipt definition unchanged");
// Replay existing receipt assertions only in a fresh namespace and rollback.
let legacy = readFileSync(
  "tests/database/gateway-evidence-contract.sql",
  "utf8",
);
legacy = transform(legacy)
  .replaceAll("public.evidence_assert", "pg_temp.evidence_assert")
  .replaceAll("public.evidence_error", "pg_temp.evidence_error")
  .replaceAll("public.test_register", "pg_temp.test_register")
  .replaceAll("public.test_receipt", "pg_temp.test_receipt");
// Original suite has deliberately global count assertions. Scope those reads.
legacy = legacy
  .replaceAll(
    "from app_private.gateway_resources)",
    `from app_private.gateway_resources where owner_id='${owner}')`,
  )
  .replaceAll(
    "from app_private.gateway_observation_receipts)",
    `from app_private.gateway_observation_receipts where owner_id='${owner}')`,
  )
  .replaceAll(
    "where kind='manifest'",
    `where owner_id='${owner}' and kind='manifest'`,
  );
// Use an entirely separate fixture identity; no retained/current rows touched.
const legacyPrefix = randomUUID().slice(0, 8);
const legacyTransform = (s) =>
  s.replaceAll(namespace.slice(1), legacyPrefix.slice(1));
let legacyFixture = legacyTransform(fixture);
legacy = legacyTransform(legacy);
// Narrow immutable-mutation assertions to this disposable namespace.
legacy = legacy.replace(
  "'delete from app_private.gateway_observation_receipts'",
  `$q$delete from app_private.gateway_observation_receipts where owner_id='${legacyTransform(owner)}'$q$`,
);
legacy = legacy.replace(
  /update app_private.gateway_resources set owner_id='([^']+)'/g,
  `update app_private.gateway_resources set owner_id='$1' where owner_id='${legacyTransform(owner)}'`,
);
run(
  "begin; " +
    legacyFixture +
    legacy.replace(/^--[^\n]*\n/, "").replace(/^begin;/, ""),
);
pass("existing receipt SQL compatibility suite (isolated rollback)");
const report = {
  phase: "2.14H.1",
  status: "COMPLETE",
  database: "smart_storage_gateway_test",
  namespace,
  owner,
  request,
  resource,
  migration,
  sha256: createHash("sha256").update(readFileSync(migration)).digest("hex"),
  passed,
  overlap,
  retainedFixtures: true,
  providerRequests: 0,
  harnessHistory: [
    "Initial run: all new-contract cases passed; legacy compatibility replay failed because of harness SQL quoting. Transaction rolled back; new namespaced contract fixtures retained.",
    "Corrected compatibility quoting; focused suite passed. Additional security metadata assertions added before final verification.",
  ],
};
writeFileSync(
  "tests/database/gateway-214h1-results.json",
  JSON.stringify(report, null, 2) + "\n",
);
