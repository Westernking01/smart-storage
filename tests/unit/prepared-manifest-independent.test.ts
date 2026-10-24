// Opt-in qualification on a NEW loopback-only cluster; no installed DB or credentials.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { seedPreparedManifest } from "../database/prepared-manifest-fixture";
import { completeSyntheticFixtureStream } from "../database/prepared-stream-completion-fixture";
import type { WriteIntent } from "../../src/lib/gateway/provider-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// An offline invocation must not create a cluster, even with a saved binary path.
const bin =
  process.env.SMART_STORAGE_RUN_FRESH_PG_QUALIFICATION === "approved"
    ? process.env.SMART_STORAGE_DISPOSABLE_PG_BIN
    : undefined;
const port = 55453; // Deliberately never accepts a caller-provided URL/port.
let root: string,
  cluster: string,
  pool: Pool,
  started = false;
let env: NodeJS.ProcessEnv;
let server: ChildProcess | undefined;
const sql =
  "select public.ss_prepared_manifest_register_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sleep = () => new Promise((r) => setTimeout(r, 20));
function diagnostic(name: string, chunk: string | Buffer) {
  appendFileSync(join(root, `${name}.log`), chunk, { mode: 0o600 });
}
async function run(name: string, args: string[]) {
  await new Promise<void>((done, reject) => {
    const child = spawn(
      join(bin!, name + (process.platform === "win32" ? ".exe" : "")),
      args,
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk: Buffer) => diagnostic(name, chunk));
    child.stderr?.on("data", (chunk: Buffer) => diagnostic(name, chunk));
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        try {
          execFileSync(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore", timeout: 5000 },
          );
        } catch {
          child.kill();
        }
      } else child.kill("SIGKILL");
      diagnostic(name, "\nPROCESS_TIMEOUT\n");
      reject(Error(`DISPOSABLE_${name}_TIMEOUT; diagnostics: ${root}`));
    }, 30000);
    child.once("error", (e) => {
      clearTimeout(timer);
      diagnostic(name, `\nSPAWN_ERROR ${e.message}\n`);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      diagnostic(name, `\nEXIT ${code}\n`);
      if (code === 0) done();
      else reject(Error(`DISPOSABLE_${name}_FAILED`));
    });
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(count = 3, withDescriptors = true) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const f = await seedPreparedManifest(c, count, withDescriptors);
    await c.query("commit");
    return f;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
async function transaction(work: (c: PoolClient) => Promise<unknown>) {
  const c = await pool.connect();
  try {
    await c.query("begin; set local role ss_gateway_executor");
    const r = await work(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const register = (f: Fixture, args = f.args) =>
  transaction((c) => c.query(sql, args));
const dispatchSql =
  "select public.ss_registered_block_dispatch_v1($1,$2,$3::jsonb)";
async function resolveIntent(f: Fixture, index: number): Promise<WriteIntent> {
  const r = await transaction((c) =>
    c.query(
      "select public.ss_registered_block_resolve_v1($1,$2,$3,$4,$5) value",
      [f.owner, f.args[2], f.args[3], index, f.executor],
    ),
  );
  return (r as { rows: { value: { intent: WriteIntent } }[] }).rows[0].value
    .intent;
}
const dispatchIntent = (f: Fixture, intent: WriteIntent) =>
  transaction((c) =>
    c.query(dispatchSql, [f.owner, f.executor, JSON.stringify(intent)]),
  );
async function state(f: Fixture) {
  const { rows } = await pool.query(
    `select
    (select count(*)::int from public.usage_events where session_id=$2) events,
    (select coalesce(jsonb_agg(to_jsonb(d) order by block_index),'[]') from public.file_blocks d where session_id=$2) descriptors,
    (select coalesce(jsonb_agg(to_jsonb(p) order by block_index),'[]') from app_private.prepared_block_plans p where owner_id=$1) plans,
    (select coalesce(jsonb_agg(to_jsonb(b) order by block_index),'[]') from app_private.prepared_block_bindings b where owner_id=$1) bindings,
    (select to_jsonb(u) from public.user_usage u where owner_id=$1) usage,
    (select to_jsonb(s) from public.upload_sessions s where id=$2) session,
    (select jsonb_agg(to_jsonb(q) order by request_id) from app_private.gateway_requests q where owner_id=$1) requests,
    (select jsonb_agg(to_jsonb(a) order by id) from public.transfer_attempts a where owner_id=$1) attempts,
    (select jsonb_agg(to_jsonb(r) order by resource_id) from app_private.gateway_resources r where owner_id=$1) resources`,
    [f.owner, f.session],
  );
  return rows[0];
}
async function waitFor(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 150; n++) {
    if (await predicate()) return;
    await sleep();
  }
  throw Error("EXPECTED_BACKEND_OVERLAP_NOT_OBSERVED");
}
async function race(
  f: Fixture,
  calls: (() => Promise<unknown>)[],
  queryPrefix: string,
) {
  const blocker = await pool.connect();
  await blocker.query("begin");
  await blocker.query(
    "select owner_id from public.user_usage where owner_id=$1 for update",
    [f.owner],
  );
  const outcomes = Promise.allSettled(calls.map((call) => call()));
  try {
    await waitFor(
      async () =>
        (
          await pool.query(
            `select count(distinct pid)::int n from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock' and query like $1`,
            [queryPrefix + "%"],
          )
        ).rows[0].n === 2,
    );
  } finally {
    await blocker.query("rollback");
    blocker.release();
  }
  const results = await outcomes;
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
}

describe.skipIf(!bin)(
  "fresh PostgreSQL multi-block registration qualification",
  () => {
    beforeAll(async () => {
      root = await mkdtemp(resolve(".cache/prepared-manifest-pg-"));
      cluster = join(root, "data");
      env = { ...process.env };
      for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
      env.PGPASSFILE = join(root, "nonexistent-passfile");
      await run("initdb", [
        "-D",
        cluster,
        "-U",
        "postgres",
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
      ]);
      let startupOutput = "";
      server = spawn(
        join(bin!, process.platform === "win32" ? "postgres.exe" : "postgres"),
        ["-D", cluster, "-h", "127.0.0.1", "-p", String(port)],
        { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const capture = (chunk: Buffer) => {
        diagnostic("postgres", chunk);
        startupOutput = (startupOutput + chunk.toString()).slice(-8192);
      };
      server.stdout?.on("data", capture);
      server.stderr?.on("data", capture);
      server.on("error", (e) => {
        startupOutput = e.message;
        diagnostic("postgres", `SPAWN_ERROR ${e.message}\n`);
      });
      server.on("exit", (code, signal) =>
        diagnostic("postgres", `\nEXIT ${code} ${signal}\n`),
      );
      started = true;
      pool = new Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password: "",
        database: "postgres",
        max: 8,
        connectionTimeoutMillis: 1000,
        statement_timeout: 10000,
        idle_in_transaction_session_timeout: 15000,
      });
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          const {
            rows: [t],
          } = await pool.query(
            "select current_setting('data_directory') dir,inet_server_port() port,current_setting('listen_addresses') listen",
          );
          // Mismatch must stop before ANY setup SQL, never retry against an existing cluster.
          expect(resolve(t.dir).toLowerCase()).toBe(
            resolve(cluster).toLowerCase(),
          );
          expect(t.port).toBe(port);
          expect(t.listen).toBe("127.0.0.1");
          ready = true;
          break;
        } catch (e) {
          if (server.exitCode !== null)
            throw Error(`DISPOSABLE_SERVER_EXIT: ${startupOutput}`);
          if (!(e instanceof Error && "code" in e && e.code === "ECONNREFUSED"))
            throw e;
          await sleep();
        }
      }
      if (!ready) throw Error(`DISPOSABLE_SERVER_NOT_READY: ${startupOutput}`);
      await pool.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth to anon,authenticated,service_role;`);
      for (const name of (await readdir("supabase/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await pool.query(
          (await readFile(join("supabase/migrations", name), "utf8")).replace(
            /^\uFEFF/,
            "",
          ),
        );
    }, 60000);
    afterAll(async () => {
      await pool?.end();
      if (started && server?.exitCode === null)
        await run("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "stop"]);
      // Retain only this run's fresh cluster for diagnosis; never clean existing state.
    }, 40000);

    it("commits all three immutable plans; duplicates and conflicting manifests preserve committed state", async () => {
      const f = await fixture(),
        before = await state(f);
      await register(f);
      const committed = await state(f);
      expect(committed.plans).toHaveLength(3);
      expect({ ...committed, plans: [] }).toEqual(before);
      await expect(register(f)).rejects.toThrow();
      const text = JSON.stringify({
        ...f.manifest,
        originalSha256: "b".repeat(64),
      });
      await expect(
        register(f, [
          ...f.args.slice(0, 3),
          sha(text),
          text,
          ...f.args.slice(5),
        ]),
      ).rejects.toThrow("IDENTITY_MISMATCH");
      expect(await state(f)).toEqual(committed);
    });
    it("rolls back all plans when the second durable attempt is missing", async () => {
      const f = await fixture(),
        before = await state(f);
      const bindings = structuredClone(f.bindings);
      bindings[1].attemptId = randomUUID();
      await expect(
        register(f, [...f.args.slice(0, 7), JSON.stringify(bindings)]),
      ).rejects.toThrow("query returned no rows");
      expect(await state(f)).toEqual(before);
      await register(f);
      expect((await state(f)).plans).toHaveLength(3);
    });
    it("rejects wrong owners, absent executors and insufficient quota without partial state", async () => {
      const f = await fixture(),
        before = await state(f);
      await expect(
        register(f, [randomUUID(), ...f.args.slice(1)]),
      ).rejects.toThrow();
      await expect(
        register(f, [f.owner, null, ...f.args.slice(2)]),
      ).rejects.toThrow("INVALID_MANIFEST");
      expect(await state(f)).toEqual(before);
      await pool.query(
        "update public.user_usage set reserved_bytes=327679 where owner_id=$1",
        [f.owner],
      );
      const short = await state(f);
      await expect(register(f)).rejects.toThrow("QUOTA_INSUFFICIENT");
      expect(await state(f)).toEqual(short);
    });
    it.each(["duplicate", "conflicting-checkpoint"])(
      "excludes independent concurrent %s registrations",
      async (mode) => {
        const f = await fixture(),
          before = await state(f);
        const other = [...f.args];
        if (mode !== "duplicate") other[2] = randomUUID();
        await race(
          f,
          [() => register(f), () => register(f, other)],
          "select public.ss_prepared_manifest_register_v1",
        );
        const committed = await state(f);
        expect(committed.plans).toHaveLength(3);
        expect(
          new Set(
            committed.plans.map(
              (b: { checkpoint_id: string }) => b.checkpoint_id,
            ),
          ).size,
        ).toBe(1);
        expect({ ...committed, plans: [] }).toEqual(before);
        await expect(register(f)).rejects.toThrow();
        expect(await state(f)).toEqual(committed);
      },
    );
    it("consumes a registered reservation once across independent competing dispatchers and blocks a second stream", async () => {
      const f = await fixture();
      await register(f);
      const before = await state(f);
      for (let index = 0; index < 1; index++) {
        const r = await transaction((c) =>
          c.query(
            "select public.ss_registered_block_resolve_v1($1,$2,$3,$4,$5) value",
            [f.owner, f.args[2], f.args[3], index, f.executor],
          ),
        );
        const intent = (r as { rows: { value: { intent: unknown } }[] }).rows[0]
          .value.intent;
        const dispatch = () =>
          transaction((c) =>
            c.query(
              "select public.ss_registered_block_dispatch_v1($1,$2,$3::jsonb)",
              [f.owner, f.executor, JSON.stringify(intent)],
            ),
          );
        await race(
          f,
          [dispatch, dispatch],
          "select public.ss_registered_block_dispatch_v1",
        );
        await expect(dispatch()).rejects.toThrow("SESSION_BLOCKED");
      }
      const after = await state(f);
      expect(after.bindings).toHaveLength(1);
      expect(after.usage).toEqual(before.usage);
      expect(after.session).toEqual(before.session);
      expect(after.plans).toEqual(before.plans);
      expect(after.requests).toHaveLength(1);
      const next = await transaction((c) =>
        c.query(
          "select public.ss_registered_block_resolve_v1($1,$2,$3,1,$4) value",
          [f.owner, f.args[2], f.args[3], f.executor],
        ),
      );
      const nextIntent = (next as { rows: { value: { intent: unknown } }[] })
        .rows[0].value.intent;
      await expect(
        transaction((c) =>
          c.query(
            "select public.ss_registered_block_dispatch_v1($1,$2,$3::jsonb)",
            [f.owner, f.executor, JSON.stringify(nextIntent)],
          ),
        ),
      ).rejects.toThrow();
      expect(await state(f)).toEqual(after);
      expect(
        after.requests.every(
          (r: { dispatched_at: unknown }) => r.dispatched_at !== null,
        ),
      ).toBe(true);
    });
    it("rolls back completed registration on transaction abort and backend termination", async () => {
      const f = await fixture(),
        before = await state(f);
      const serverStart = (
        await pool.query("select pg_postmaster_start_time() started")
      ).rows[0].started;
      const c = await pool.connect();
      let dead = false;
      c.on("error", () => {});
      try {
        await c.query("begin;set local role ss_gateway_executor");
        await c.query(sql, f.args);
        expect(await state(f)).toEqual(before); // Separate observer cannot see uncommitted bindings.
        await c.query("rollback");
        expect(await state(f)).toEqual(before);
        await c.query("begin;set local role ss_gateway_executor");
        await c.query(sql, f.args);
        const pid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
        expect(
          (
            await pool.query("select pg_terminate_backend($1) terminated", [
              pid,
            ])
          ).rows[0].terminated,
        ).toBe(true);
        dead = true;
        await waitFor(
          async () =>
            !(
              await pool.query("select 1 from pg_stat_activity where pid=$1", [
                pid,
              ])
            ).rowCount,
        );
        await expect(c.query("select 1")).rejects.toThrow();
        expect(
          (await pool.query("select pg_postmaster_start_time() started"))
            .rows[0].started,
        ).toEqual(serverStart);
        expect(await state(f)).toEqual(before);
      } finally {
        if (!dead) await c.query("rollback");
        c.release(dead);
      }
      await register(f);
      expect((await state(f)).plans).toHaveLength(3);
    });
    it("retains committed bindings after SIMULATED post-acknowledgment caller failure and preserves immutable/private authority", async () => {
      const f = await fixture();
      const writer = await pool.connect();
      try {
        await writer.query("begin;set local role ss_gateway_executor");
        await writer.query(sql, f.args);
        await expect(
          (async () => {
            await writer.query("commit");
            throw Error("SIMULATED_LOST_COMMIT_ACK");
          })(),
        ).rejects.toThrow("SIMULATED_LOST_COMMIT_ACK");
      } finally {
        writer.release(true);
      }
      const committed = await state(f);
      expect(committed.plans).toHaveLength(3);
      await expect(register(f)).rejects.toThrow();
      await expect(
        pool.query(
          "update app_private.prepared_block_plans set checkpoint_id='changed' where owner_id=$1",
          [f.owner],
        ),
      ).rejects.toThrow("PREPARED_BINDING_IMMUTABLE");
      await expect(
        pool.query(
          "delete from app_private.prepared_block_plans where owner_id=$1",
          [f.owner],
        ),
      ).rejects.toThrow("PREPARED_BINDING_IMMUTABLE");
      for (const role of [
        "authenticated",
        "service_role",
        "ss_gateway_executor",
      ]) {
        const c = await pool.connect();
        try {
          await c.query(`begin;set local role ${role}`);
          await expect(
            c.query("select * from app_private.prepared_block_plans"),
          ).rejects.toThrow("permission denied");
        } finally {
          await c.query("rollback");
          c.release();
        }
      }
      const {
        rows: [security],
      } = await pool.query(`select relrowsecurity rls,
      (select tgenabled='O' from pg_trigger where tgrelid=c.oid and tgname='prepared_binding_immutable') immutable,
      has_function_privilege('authenticated','public.ss_prepared_manifest_register_v1(uuid,uuid,text,text,text,uuid,uuid,jsonb)','execute') ordinary,
      has_function_privilege('ss_gateway_executor','public.ss_prepared_manifest_register_v1(uuid,uuid,text,text,text,uuid,uuid,jsonb)','execute') executor
      from pg_class c where c.oid='app_private.prepared_block_bindings'::regclass`);
      expect(security).toEqual({
        rls: true,
        immutable: true,
        ordinary: false,
        executor: true,
      });
      expect(await state(f)).toEqual(committed);
    });
    it("dispatches all three blocks after synthetic conclusive completion with one held stream and one reservation event", async () => {
      const f = await fixture(3, false);
      const reserved = await state(f);
      await register(f);
      const registered = await state(f);
      expect(registered.events).toBe(1);
      for (let index = 0; index < 3; index++) {
        const intent = await resolveIntent(f, index);
        await race(
          f,
          [() => dispatchIntent(f, intent), () => dispatchIntent(f, intent)],
          "select public.ss_registered_block_dispatch_v1",
        );
        const held = await state(f);
        expect(
          held.requests.filter((r: { slot_held: boolean }) => r.slot_held),
        ).toHaveLength(1);
        expect(held.bindings).toHaveLength(index + 1);
        if (index < 2) {
          const next = await resolveIntent(f, index + 1);
          await expect(dispatchIntent(f, next)).rejects.toThrow();
          expect(await state(f)).toEqual(held);
          await pool.query(
            "select public.ss_gateway_record_stream_outcome_v1($1,$2,$3,$4,'request_completed')",
            [f.owner, intent.requestId, f.executor, randomUUID()],
          );
          const reported = await state(f);
          await expect(dispatchIntent(f, next)).rejects.toThrow();
          expect(await state(f)).toEqual(reported);
          const c = await pool.connect();
          try {
            await completeSyntheticFixtureStream(c, f, intent);
          } finally {
            c.release();
          }
        }
      }
      const after = await state(f);
      expect(after.usage).toEqual(reserved.usage);
      expect(after.session).toEqual(registered.session);
      expect(after.plans).toEqual(registered.plans);
      expect(after.events).toBe(1);
      expect(
        after.attempts.reduce(
          (n: number, a: { attempted_bytes: string }) =>
            n + Number(a.attempted_bytes),
          0,
        ),
      ).toBe(196608);
    });
    it.each(["rollback", "terminate"])(
      "restores dispatch state after %s before COMMIT (backend only, not server crash)",
      async (mode) => {
        const f = await fixture();
        await register(f);
        const intent = await resolveIntent(f, 0),
          before = await state(f);
        const serverStart = (
          await pool.query("select pg_postmaster_start_time() started")
        ).rows[0].started;
        const c = await pool.connect();
        c.on("error", () => {});
        let dead = false;
        try {
          await c.query("begin;set local role ss_gateway_executor");
          await c.query(dispatchSql, [
            f.owner,
            f.executor,
            JSON.stringify(intent),
          ]);
          expect(await state(f)).toEqual(before);
          if (mode === "rollback") await c.query("rollback");
          else {
            const pid = (await c.query("select pg_backend_pid() pid")).rows[0]
              .pid;
            expect(
              (
                await pool.query("select pg_terminate_backend($1) terminated", [
                  pid,
                ])
              ).rows[0].terminated,
            ).toBe(true);
            dead = true;
            await waitFor(
              async () =>
                !(
                  await pool.query(
                    "select 1 from pg_stat_activity where pid=$1",
                    [pid],
                  )
                ).rowCount,
            );
            await expect(c.query("select 1")).rejects.toThrow();
          }
          expect(await state(f)).toEqual(before);
          expect(
            (await pool.query("select pg_postmaster_start_time() started"))
              .rows[0].started,
          ).toEqual(serverStart);
        } finally {
          if (!dead) await c.query("rollback");
          c.release(dead);
        }
        await dispatchIntent(f, intent);
        const after = await state(f);
        expect(after.bindings).toHaveLength(1);
        expect(after.usage).toEqual(before.usage);
        await expect(dispatchIntent(f, intent)).rejects.toThrow();
        expect(await state(f)).toEqual(after);
      },
    );
    it.each(["registration", "dispatch"])(
      "drops the client COMMIT response for %s; independent observer reconciles without replay",
      async (mode) => {
        const f = await fixture();
        if (mode === "dispatch") await register(f);
        const before = await state(f);
        const intent =
          mode === "dispatch" ? await resolveIntent(f, 0) : undefined;
        const c = await pool.connect();
        c.on("error", () => {});
        // Test-only pg socket access: pause inbound delivery before sending COMMIT.
        // Observe committed state separately, then destroy the unread response.
        const stream = (
          c as unknown as { connection: { stream: import("node:net").Socket } }
        ).connection.stream;
        let result: Promise<string> | undefined;
        try {
          await c.query("begin;set local role ss_gateway_executor");
          if (intent)
            await c.query(dispatchSql, [
              f.owner,
              f.executor,
              JSON.stringify(intent),
            ]);
          else await c.query(sql, f.args);
          expect(await state(f)).toEqual(before);
          stream.pause();
          result = c.query("commit").then(
            () => "ACK_DELIVERED",
            () => "ACK_LOST",
          );
          await waitFor(async () => {
            const observed = await state(f);
            return mode === "registration"
              ? observed.plans.length === 3
              : observed.bindings.length === 1;
          });
          stream.destroy();
          expect(await result).toBe("ACK_LOST");
        } finally {
          stream.destroy();
          await result;
          c.release(true);
        }
        const committed = await state(f);
        expect(committed.plans).toHaveLength(3);
        expect(committed.usage).toEqual(before.usage);
        expect(committed.events).toEqual(before.events);
        if (mode === "dispatch") {
          expect(committed.bindings).toHaveLength(1);
          expect(
            committed.attempts.reduce(
              (n: number, a: { attempted_bytes: string }) =>
                n + Number(a.attempted_bytes),
              0,
            ),
          ).toBe(65536);
          expect(
            committed.requests.filter(
              (r: { slot_held: boolean }) => r.slot_held,
            ),
          ).toHaveLength(1);
          const next = await resolveIntent(f, 1);
          await expect(dispatchIntent(f, next)).rejects.toThrow();
        }
        expect(await state(f)).toEqual(committed);
        // No server crash/restart, provider operation or power-loss claim.
      },
    );
  },
);
