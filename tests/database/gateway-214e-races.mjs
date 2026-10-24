// Bounded independent PostgreSQL transactions; synthetic fixtures only.
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const database = "smart_storage_gateway_test";
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
env.PGCONNECT_TIMEOUT = "3";
const evidence = JSON.parse(
  readFileSync("tests/database/gateway-214e-results.json", "utf8"),
);
if (evidence.status === "COMPLETE")
  throw new Error(
    "Completed race evidence is retained; no replay authorized by this harness",
  );
if (
  evidence.migrations.length !== 7 ||
  (evidence.races && process.argv[2] !== "--resume")
)
  throw new Error(
    "Require completed bootstrap; prior race run requires explicit --resume after evidence review",
  );
evidence.races ??= [];
const save = () =>
  writeFileSync(
    "tests/database/gateway-214e-results.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
save();
const connections = [];
const until = async (fn) => {
  const end = Date.now() + 12000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Barrier deadline exceeded");
    await delay(25);
  }
};
function connect(name) {
  const child = spawn(
    "C:/Program Files/PostgreSQL/17/bin/psql.exe",
    [
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
      database,
    ],
    { env: { ...env, PGAPPNAME: name }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const c = { child, out: "", err: "", closed: false, seq: 0 };
  child.stdout.on("data", (d) => (c.out += d));
  child.stderr.on("data", (d) => (c.err += d));
  child.on("error", (e) => {
    c.err += e.message;
    c.closed = true;
  });
  child.on("close", () => (c.closed = true));
  c.run = async (input) => {
    const start = c.out.length;
    const marker = `DONE_${name}_${++c.seq}`;
    child.stdin.write(`${input}\nselect '${marker}';\n`);
    await until(() => c.out.slice(start).includes(marker) || c.closed);
    if (c.closed) throw new Error(`${name}: ${c.err}`);
    return c.out.slice(start).split(marker)[0].trim();
  };
  connections.push(c);
  return c;
}
const observer = connect("ss214e_observer");
const fixture = readFileSync(
  "tests/database/gateway-claims-fixture.sql",
  "utf8",
);
const final = readFileSync(
  "tests/database/gateway-finalization-cleanup-contract.sql",
  "utf8",
);
let scenario = evidence.nextScenario ?? 0;
const id = (p, n = 1) =>
  `${p}0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
async function context(prepared = false) {
  const n = ++scenario;
  evidence.nextScenario = n;
  save();
  const prefix = (p) =>
    `${p}00000${String(n).padStart(2, "0")}-0000-0000-0000-`;
  const transform = (s) =>
    s
      .replace(/([0-9a-d])0000000-0000-0000-0000-/g, (_, p) => prefix(p))
      .replace(/\bfinal_/g, `race${n}_`)
      .replace(/\bcerts\b/g, `race${n}_certs`)
      .replace(/\bjob\b/g, `race${n}_job`)
      .replace(/create temp table/g, "create table")
      .replaceAll("sql-fixture-only", `sql-fixture-only-${n}`);
  const uid = (p, k = 1) => transform(id(p, k));
  let setup = transform(fixture);
  for (const [table, p] of [
    ["auth.users", "0"],
    ["public.files", "1"],
    ["public.upload_sessions", "2"],
    ["public.file_blocks", "3"],
  ]) {
    setup = setup.replaceAll(
      `from ${table};`,
      `from ${table} where ${table === "auth.users" ? "id" : "id"}::text like '${prefix(p)}%';`,
    );
  }
  await observer.run(`begin; ${setup} commit;`);
  const x = {
    n,
    uid,
    transform,
    owner: uid(0),
    request: uid(5),
    executor: uid(6),
    session: uid(2),
    resource: uid(7),
    helper: `race${n}_`,
    certs: `public.race${n}_certs`,
    job: `public.race${n}_job`,
  };
  x.claim = (k = 1, r = k, owner = x.owner) =>
    `select public.ss_gateway_claim_v1('${owner}','${uid(4, k)}','${uid(5, r)}',8,'${x.executor}');`;
  x.dispatch = `select public.ss_gateway_dispatch_v1('${x.owner}','${x.request}','${x.executor}',1);`;
  if (prepared) {
    let sql = transform(
      final.slice(
        0,
        final.indexOf(
          prepared === "registered"
            ? "select public.ss_gateway_dispatch_v1"
            : prepared === "writers"
              ? "-- Under 007"
              : "-- 2 missing block",
        ),
      ),
    );
    sql = sql.replaceAll(
      "from app_private.gateway_resources;",
      `from app_private.gateway_resources where session_id='${x.session}';`,
    );
    sql = sql.replace(
      "from app_private.gateway_resources r join",
      `from (select * from app_private.gateway_resources where session_id='${x.session}') r join`,
    );
    await observer.run(`${sql} commit;`);
  }
  return x;
}
const expect = (statement, error) =>
  `do $test$ begin begin execute $stmt$${statement}$stmt$; exception when others then if position('${error}' in sqlerrm)>0 then return; end if; raise; end; raise exception 'EXPECTED_${error}'; end $test$;`;
async function assert(query) {
  if ((await observer.run(`select (${query})::text;`)) !== "true")
    throw new Error(`Postcondition failed: ${query}`);
}
async function race(label, first, second, { rollback = false, check } = {}) {
  if (evidence.races.some((r) => r.label === label)) return;
  evidence.currentRace = label;
  const a = connect(`ss214e_a_${scenario}_${evidence.races.length}`);
  const b = connect(`ss214e_b_${scenario}_${evidence.races.length}`);
  const pids = [
    Number(await a.run("select pg_backend_pid();")),
    Number(await b.run("select pg_backend_pid();")),
    Number(await observer.run("select pg_backend_pid();")),
  ];
  if (new Set(pids).size !== 3)
    throw new Error("Backend PIDs are not distinct");
  for (const c of [a, b, observer])
    if ((await c.run("show transaction_isolation;")) !== "read committed")
      throw new Error("READ COMMITTED required");
  await a.run(
    `begin isolation level read committed; set local statement_timeout='10s'; set local lock_timeout='8s'; ${first}`,
  );
  let resultB, errorB;
  const pending = b
    .run(
      `begin isolation level read committed; set local statement_timeout='10s'; set local lock_timeout='8s'; ${second} commit;`,
    )
    .then(
      (r) => (resultB = r),
      (e) => (errorB = e),
    );
  await until(
    async () =>
      (await observer.run(
        `select exists(select from pg_stat_activity where pid=${pids[1]} and wait_event_type='Lock' and ${pids[0]}=any(pg_blocking_pids(pid)))::text;`,
      )) === "true",
  );
  const locks = await observer.run(
    `select json_build_object('waiting_pid',${pids[1]},'blockers',pg_blocking_pids(${pids[1]}),'wait_event',(select wait_event from pg_stat_activity where pid=${pids[1]}));`,
  );
  await a.run(rollback ? "rollback;" : "commit;");
  await pending;
  if (errorB) throw errorB;
  if (check) await check(resultB);
  evidence.races.push({
    label,
    pids,
    isolation: "read committed",
    barrier: JSON.parse(locks),
    firstOutcome: rollback ? "rollback" : "commit",
    result: "PASS",
  });
  save();
  console.log(`PASS concurrent ${label}`);
  a.child.stdin.end("\\q\n");
  b.child.stdin.end("\\q\n");
}
try {
  // Discover retained synthetic fixture namespaces before allocating a fresh one.
  // Failed attempts are never deleted or reused on resume.
  scenario = Math.max(
    scenario,
    Number(
      await observer.run(
        "select coalesce(max(substring(id::text,7,2)::integer),0) from auth.users where left(id::text,6)='000000';",
      ),
    ),
  );
  if (
    process.argv[2] === "--resume" &&
    !evidence.failures?.some((f) => f.error === "Barrier deadline exceeded")
  ) {
    evidence.failures ??= [];
    evidence.failures.unshift({
      scenario: 6,
      race: "lease expiry retains occupancy",
      error: "Barrier deadline exceeded",
      cause:
        "Harness locked session 1 while waiter claimed session 2; corrected with shared account lock",
    });
  }
  let x = await context();
  await race(
    "active-stream capacity",
    `set local role ss_gateway_executor; ${x.claim()}`,
    `set local role ss_gateway_executor; ${expect(x.claim(2), "CAPACITY_EXCEEDED")}`,
    {
      check: () =>
        assert(
          `(select count(*)=1 from app_private.gateway_requests where owner_id='${x.owner}')`,
        ),
    },
  );
  x = await context();
  await race(
    "duplicate claim idempotency",
    `set local role ss_gateway_executor; ${x.claim()}`,
    `set local role ss_gateway_executor; ${x.claim()}`,
    {
      check: async (r) => {
        if (!r.includes('"ambiguous"'))
          throw new Error("Replay did not return ambiguous");
        await assert(
          `(select count(*)=1 from app_private.gateway_requests where owner_id='${x.owner}') and (select attempted_bytes=8 from public.transfer_attempts where id='${x.uid(4)}')`,
        );
      },
    },
  );
  x = await context();
  await race(
    "rollback admits waiter without accounting leak",
    `set local role ss_gateway_executor; ${x.claim()}`,
    `set local role ss_gateway_executor; ${x.claim(2)}`,
    {
      rollback: true,
      check: () =>
        assert(
          `(select attempted_bytes=0 from public.transfer_attempts where id='${x.uid(4)}') and (select count(*)=1 from app_private.gateway_requests where owner_id='${x.owner}')`,
        ),
    },
  );
  // Prepared fixtures include administrator-imported SQL-only certificates.
  x = await context("registered");
  await race(
    "one-time dispatch",
    `set local role ss_gateway_executor; ${x.dispatch}`,
    `set local role ss_gateway_executor; ${expect(x.dispatch, "ALREADY_DISPATCHED")}`,
    {
      check: () =>
        assert(
          `(select dispatched_at is not null from app_private.gateway_requests where request_id='${x.request}')`,
        ),
    },
  );
  x = await context();
  await observer.run(x.claim());
  await race(
    "epoch fencing",
    `update public.upload_sessions set epoch=2 where id='${x.session}';`,
    `set local role ss_gateway_executor; ${expect(x.dispatch, "STALE_EPOCH")}`,
  );
  x = await context(true);
  await race(
    "lease expiry retains occupancy",
    `select * from public.user_usage where owner_id='${x.owner}' for update; update public.upload_sessions set lease_expires_at=clock_timestamp()-interval '1 second' where id='${x.session}';`,
    `set local role ss_gateway_executor; ${expect(x.claim(2), "CAPACITY_EXCEEDED")}`,
    {
      check: () =>
        assert(
          `(select count(*)=1 from app_private.gateway_requests where owner_id='${x.owner}' and slot_held) and (select reserved_bytes=262160 from public.user_usage where owner_id='${x.owner}')`,
        ),
    },
  );
  x = await context();
  // Unauthorized caller waits behind the genuine owner's claim, then is denied.
  await race(
    "cross-account authorization after row barrier",
    `select * from public.user_usage where owner_id='${x.uid(0, 2)}' for update; set local role ss_gateway_executor; ${x.claim()}`,
    `select * from public.user_usage where owner_id='${x.uid(0, 2)}' for update; set local role ss_gateway_executor; ${expect(x.claim(1, 2, x.uid(0, 2)), "FORBIDDEN")}`,
    {
      check: () =>
        assert(
          `(select count(*)=1 from app_private.gateway_requests where owner_id='${x.owner}') and (select count(*)=0 from app_private.gateway_requests where owner_id='${x.uid(0, 2)}')`,
        ),
    },
  );
  x = await context(true);
  const scope = await observer.run(
    `select scope from app_private.gateway_resources where resource_id='${x.resource}';`,
  );
  const receipt = (bytes) =>
    `select public.ss_gateway_record_receipt_v1('${x.owner}','${x.resource}','${x.uid(8, 99)}',1,jsonb_build_object('scope','${scope}'::jsonb,'kind','inspection','outcome','present','observedAt','2026-01-01T00:00:00Z','observedBytes',${bytes},'provenance','{}'::jsonb,'verifierRevision','SQL ONLY'));`;
  await race(
    "immutable provider receipt conflict",
    `set local role ss_gateway_observer; ${receipt(8)}`,
    `set local role ss_gateway_observer; ${expect(receipt(9), "IDEMPOTENCY_CONFLICT")}`,
    {
      check: () =>
        assert(
          `(select count(*)=1 and min(observed_bytes)=8 from app_private.gateway_observation_receipts where operation_key='${x.uid(8, 99)}')`,
        ),
    },
  );
  x = await context("writers");
  const completeBlock = `select public.ss_gateway_complete_stream_v1('${x.owner}','${x.request}',1,'${x.uid("a", 55)}','${x.resource}',(select id from ${x.certs} where kind='present'),(select id from ${x.certs} where kind='terminal' and rid='${x.resource}'));`;
  await observer.run(completeBlock);
  const writer = (rid, req) =>
    `select public.ss_gateway_claim_resource_v1('${x.owner}','${x.uid(7, rid)}','${x.uid(5, req)}',1,8,'${x.executor}');`;
  await race(
    "manifest versus temporary writer capacity",
    `set local role ss_gateway_executor; ${writer(2, 20)}`,
    `set local role ss_gateway_executor; ${expect(writer(3, 21), "CAPACITY_EXCEEDED")}`,
    {
      check: () =>
        assert(
          `(select count(*)=1 from app_private.gateway_requests where owner_id='${x.owner}' and slot_held)`,
        ),
    },
  );
  x = await context(true);
  const register = `select public.${x.helper}register(4,'part','new-part','${x.uid(7, 3)}');`;
  await race(
    "cleanup freezes membership and fences registration",
    `set local role ss_gateway_cleaner; select public.ss_gateway_begin_cleanup_v1('${x.owner}','${x.session}');`,
    `set local role ss_gateway_executor; ${expect(register, "STALE_EPOCH")}`,
    {
      check: () =>
        assert(
          `(select count(*)=3 from app_private.gateway_resources where session_id='${x.session}') and (select held_bytes=131080 and slot_held from public.upload_sessions where id='${x.session}')`,
        ),
    },
  );
  async function cleanupContext() {
    const c = await context(true);
    let setup = final.slice(
      final.indexOf("create temp table job as"),
      final.indexOf("-- 8 missing termination"),
    );
    setup = c
      .transform(setup)
      .replaceAll(
        "from app_private.gateway_resources;",
        `from app_private.gateway_resources where session_id='${c.session}';`,
      );
    setup = setup.replace(
      "count(*)=3 from app_private.gateway_cleanup_members",
      `count(*)=3 from app_private.gateway_cleanup_members where job_id=(select id from ${c.job})`,
    );
    await observer.run(`begin; ${setup} commit;`);
    return c;
  }
  x = await cleanupContext();
  await observer.run(
    `update public.cleanup_jobs set lease_until=clock_timestamp()-interval '1 second' where id=(select id from ${x.job});`,
  );
  const lease = `select public.ss_gateway_lease_cleanup_v1('${x.owner}',(select id from ${x.job}));`;
  await observer.run(`grant select on ${x.job} to ss_gateway_cleaner;`);
  await race(
    "cleanup lease takeover",
    `set local role ss_gateway_cleaner; ${lease}`,
    `set local role ss_gateway_cleaner; ${expect(lease, "LEASE_BLOCKED")}`,
    {
      check: () =>
        assert(
          `(select lease_epoch=2 from public.cleanup_jobs where id=(select id from ${x.job}))`,
        ),
    },
  );
  x = await cleanupContext();
  const removalStart = final.indexOf(
    "select public.ss_gateway_record_removal_v1",
    final.indexOf("-- 11 cross-account"),
  );
  const removals = final.slice(
    removalStart,
    final.indexOf("-- Exact duplicate removal"),
  );
  await observer.run(castRemoval(x, removals));
  function castRemoval(c, s) {
    return c.transform(s);
  }
  await observer.run(
    `grant select on ${x.job},${x.certs} to ss_gateway_cleaner;`,
  );
  const settle = `select public.${x.helper}settle();`;
  await race(
    "exactly-once reservation settlement",
    `set local role ss_gateway_cleaner; ${settle}`,
    `set local role ss_gateway_cleaner; ${settle}`,
    {
      check: () =>
        assert(
          `(select count(*)=1 from app_private.gateway_settlements where session_id='${x.session}') and (select count(*)=1 from public.usage_events where event_key='settle:${x.session}') and (select reserved_bytes=131080 and active_slots=1 from public.user_usage where owner_id='${x.owner}')`,
        ),
    },
  );
  evidence.status = "COMPLETE";
  delete evidence.currentRace;
  delete evidence.failure;
} catch (error) {
  evidence.failure = error.message;
  evidence.failures ??= [];
  evidence.failures.push({
    scenario,
    race: evidence.currentRace,
    error: error.message,
  });
  evidence.status = "BLOCKED";
  throw error;
} finally {
  save();
  for (const c of connections) c.child.kill();
}
