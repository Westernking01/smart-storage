// No SDK, .env, network provider, Docker, or new dependency. PostgreSQL mode
// accepts only a literal loopback host and an empty, explicitly named test DB.
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const migrations = [
  "202610130001_backend_schema.sql",
  "202610130002_control_functions.sql",
  "202610130003_trusted_transitions_and_rls.sql",
  "202610160004_gateway_claim_contracts.sql",
];
const bootstrap = `
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on all functions in schema auth to authenticated;
`;
const files = [
  ...migrations.map((name) => `supabase/migrations/${name}`),
  "tests/database/gateway-claims-fixture.sql",
  "tests/database/gateway-claims-contract.sql",
  "supabase/migrations/202610160005_gateway_provider_evidence.sql",
  "tests/database/gateway-evidence-contract.sql",
  "supabase/migrations/202610160006_gateway_preparation_cleanup.sql",
  "tests/database/gateway-finalization-cleanup-contract.sql",
  "supabase/migrations/202610160007_gateway_lifecycle.sql",
  "tests/database/gateway-finalization-cleanup-contract.sql",
  "tests/database/gateway-lifecycle-contract.sql",
];
const mode = process.argv[2];
if (mode === "--pglite") {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create();
  try {
    await db.exec(bootstrap);
    for (const file of files) {
      try {
        await db.exec(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(
          `${file}: ${error.message}; detail=${error.detail ?? ""}; context=${error.where ?? ""}`,
        );
      }
      console.log(`PASS ${file}`);
    }
    console.log(
      "PGlite SQL/serial assertions passed; independent-connection races NOT verified.",
    );
  } finally {
    await db.close();
  }
} else if (mode === "--postgres") {
  const [database, port = "5432", user = "postgres"] = process.argv.slice(3);
  if (
    !/^ss_gateway_212a_test_[a-z0-9_]+$/.test(database ?? "") ||
    !/^\d{1,5}$/.test(port)
  ) {
    throw new Error(
      "Use --postgres ss_gateway_212a_test_<unique_suffix> [port] [user]; create an empty disposable database first.",
    );
  }
  // Ignore connection service/options inherited from the host; host cannot be a
  // URL or resolve remotely. Authentication uses local pgpass/PGPASSWORD only.
  const env = { ...process.env };
  for (const key of [
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGOPTIONS",
    "PGHOST",
    "PGHOSTADDR",
    "PGDATABASE",
  ])
    delete env[key];
  env.PGCONNECT_TIMEOUT = "3";
  const args = [
    "-X",
    "-w",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    port,
    "-U",
    user,
    "-d",
    database,
  ];
  const sql = (input) => {
    const r = spawnSync("psql", args, {
      input,
      encoding: "utf8",
      env,
      timeout: 15000,
    });
    if (r.error || r.status !== 0)
      throw new Error(r.error?.message ?? r.stderr);
    return r.stdout.trim();
  };
  if (
    sql(
      "select count(*) from pg_namespace where nspname not in ('public','information_schema') and nspname !~ '^pg_';",
    ) !== "0" ||
    sql(
      "select count(*) from pg_class where relnamespace='public'::regnamespace;",
    ) !== "0"
  )
    throw new Error("Test database must be empty.");
  sql(bootstrap);
  for (const file of files) {
    sql(readFileSync(file, "utf8"));
    console.log(`PASS ${file}`);
  }
  const id = (prefix, n) =>
    `${prefix}0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const claim = (owner, attempt, request) =>
    `select public.ss_gateway_claim_v1('${id(0, owner)}','${id(4, attempt)}','${id(5, request)}',8,'${id(6, 1)}');`;
  const connection = (name) => {
    const child = spawn("psql", args, {
      env: { ...env, PGAPPNAME: name },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state = { child, out: "", err: "", done: false, code: null };
    child.stdout.on("data", (d) => {
      state.out += d;
    });
    child.stderr.on("data", (d) => {
      state.err += d;
    });
    child.on("error", (e) => {
      state.err += e.message;
      state.done = true;
    });
    child.on("close", (code) => {
      state.code = code;
      state.done = true;
    });
    return state;
  };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message);
      await delay(30);
    }
  };
  // A holds the account row after claiming; B uses an independent backend.
  // A commits/rolls back ONLY after a third connection observes B waiting on a
  // PostgreSQL lock. No scheduler timing assumption or JS race mock.
  for (const rollback of [false, true]) {
    const owner = rollback ? 2 : 1;
    const first = rollback ? 3 : 1;
    const a = connection(`ss212a_a_${owner}`);
    let b;
    try {
      a.child.stdin.write(
        `begin; set local role ss_gateway_executor; ${claim(owner, first, first)} select 'CLAIM_LOCK_HELD';\n`,
      );
      await until(
        () => a.out.includes("CLAIM_LOCK_HELD") || a.done,
        "First claim did not reach barrier",
      );
      if (a.done) throw new Error(a.err);
      b = connection(`ss212a_b_${owner}`);
      b.child.stdin.end(
        `set role ss_gateway_executor; ${claim(owner, first + 1, first + 1)}\n`,
      );
      await until(
        () =>
          sql(
            `select count(*) from pg_stat_activity where application_name='ss212a_b_${owner}' and wait_event_type='Lock';`,
          ) === "1",
        "Second backend did not block on account lock",
      );
      a.child.stdin.end(rollback ? "rollback;\n" : "commit;\n");
      await until(() => a.done && b.done, "Race connections did not finish");
      if (
        a.code !== 0 ||
        (rollback
          ? b.code !== 0 || !b.out.includes('"claimed"')
          : b.code === 0 || !b.err.includes("CAPACITY_EXCEEDED"))
      ) {
        throw new Error(`Unexpected race result: ${a.err} ${b.err} ${b.out}`);
      }
      if (
        sql(
          `select count(*) from app_private.gateway_requests where owner_id='${id(0, owner)}';`,
        ) !== "1"
      )
        throw new Error("Capacity overallocated or leaked");
      if (
        rollback &&
        sql(
          `select attempted_bytes from public.transfer_attempts where id='${id(4, first)}';`,
        ) !== "0"
      )
        throw new Error("Rollback leaked attempt counter");
      console.log(
        `PASS independent connections: ${rollback ? "rollback allows waiting claim" : "commit rejects excess claim"}`,
      );
    } finally {
      a.child.kill();
      b?.child.kill();
    }
  }
  console.log(
    "PASS local PostgreSQL integration and lock-barrier races. Disposable database retained for inspection.",
  );
} else {
  throw new Error(
    "Choose --pglite (serial SQL validation) or --postgres (real local connection races).",
  );
}
