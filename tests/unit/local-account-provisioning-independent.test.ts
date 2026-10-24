// Fresh disposable PostgreSQL cluster ONLY; never reads .env or pgpass files.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";

it.skipIf(!process.env.SMART_STORAGE_DISPOSABLE_PG_BIN)(
  "serializes independent local provisioning without double account creation",
  async () => {
    const bin = process.env.SMART_STORAGE_DISPOSABLE_PG_BIN!;
    const root = await mkdtemp(resolve(".cache/principals-pg-"));
    const cluster = join(root, "data");
    // Only this newly-created cluster, loopback-only on a distinct port.
    const port = 55449;
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
    env.PGPASSFILE = join(root, "nonexistent-passfile");
    const run = (name: string, args: string[]) =>
      new Promise<void>((done, reject) => {
        const child = spawn(
          join(bin, name + (process.platform === "win32" ? ".exe" : "")),
          args,
          { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        const capture = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8192);
        };
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        const timer = setTimeout(
          () => {
            // Kill only the process tree launched by THIS invocation, including
            // initdb's bootstrap subprocess. Never select existing processes by name.
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
            reject(
              new Error(
                `DISPOSABLE_POSTGRES_${name.toUpperCase()}_TIMEOUT: ${output}`,
              ),
            );
          },
          name === "initdb" ? 60_000 : 30_000,
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) done();
          else
            reject(
              new Error(
                `DISPOSABLE_POSTGRES_${name.toUpperCase()}_FAILED (${code}): ${output}`,
              ),
            );
        });
      });
    let started = false;
    const pool = new Pool({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "",
      database: "postgres",
      max: 5,
      connectionTimeoutMillis: 3000,
    });
    try {
      await run("initdb", [
        "-D",
        cluster,
        "-U",
        "postgres",
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
        "--no-sync",
      ]);
      // Foreground server avoids pg_ctl startup/descendant pipe lifetime races
      // on Windows. Verify the exact new data directory before any SQL setup.
      const server = spawn(
        join(bin, process.platform === "win32" ? "postgres.exe" : "postgres"),
        ["-D", cluster, "-h", "127.0.0.1", "-p", String(port)],
        { env, windowsHide: true, stdio: "ignore" },
      );
      server.on("error", () => {});
      started = true;
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          const result = await pool.query(
            "select current_setting('data_directory') dir",
          );
          expect(resolve(result.rows[0].dir).toLowerCase()).toBe(
            resolve(cluster).toLowerCase(),
          );
          ready = true;
          break;
        } catch (error) {
          if (server.exitCode !== null) throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(ready).toBe(true);
      await pool.query(`create role ss_volume_runtime noinherit; create role anon; create role authenticated; create role service_role bypassrls;
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

      const historical = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await pool.query(`insert into auth.users values('${historical}');
        insert into public.profiles(id) values('${historical}');
        insert into public.user_usage(owner_id,quota_bytes,reserved_bytes,active_slots,max_slots)
        values('${historical}',900000,123456,1,2)`);
      const snapshot = async () =>
        (
          await pool.query(
            "select row_to_json(p) profile,row_to_json(u) usage from public.profiles p join public.user_usage u on u.owner_id=p.id where p.id=$1",
            [historical],
          )
        ).rows;
      const existing = await snapshot();
      const sql = (
        await readFile("docs/local-account-provisioning.sql", "utf8")
      ).replace(
        "current_database()<>'smart_storage_gateway_test'",
        "current_database()<>'postgres'",
      );
      await pool.query(sql);
      const subject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const issuer = "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1";
      const blocker = await pool.connect(),
        a = await pool.connect(),
        b = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query(
          "select pg_advisory_xact_lock(hashtextextended($1,0))",
          [subject],
        );
        const pids = [
          (await a.query("select pg_backend_pid() pid")).rows[0].pid,
          (await b.query("select pg_backend_pid() pid")).rows[0].pid,
        ];
        const query =
          "select app_private.provision_local_account($1,$2,262144,1)";
        const first = a.query(query, [issuer, subject]),
          second = b.query(query, [issuer, subject]);
        let waiting = false;
        for (let n = 0; n < 100; n++) {
          const r = await blocker.query(
            "select count(*)::int n from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'",
            [pids],
          );
          if (r.rows[0].n === 2) {
            waiting = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(waiting).toBe(true);
        await blocker.query("commit");
        await Promise.all([first, second]);
        expect(
          (
            await pool.query(
              "select count(*)::int n from public.user_usage where owner_id=$1",
              [subject],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        for (const table of [
          "app_private.local_principals",
          "public.profiles",
        ]) {
          expect(
            (
              await pool.query(
                `select count(*)::int n from ${table} where id=$1`,
                [subject],
              )
            ).rows,
          ).toEqual([{ n: 1 }]);
        }
        const provision = (id: string, quota = 262144) =>
          pool.query("select app_private.provision_local_account($1,$2,$3,1)", [
            issuer,
            id,
            quota,
          ]);
        const current = (
          await pool.query(
            "select * from public.user_usage where owner_id=$1",
            [subject],
          )
        ).rows;
        await expect(provision(subject, 524288)).rejects.toThrow(
          "PROVISIONING_STATE_CONFLICT",
        );
        expect(
          (
            await pool.query(
              "select * from public.user_usage where owner_id=$1",
              [subject],
            )
          ).rows,
        ).toEqual(current);
        await expect(provision(historical)).rejects.toThrow(
          "PRINCIPAL_COLLISION",
        );
        expect(await snapshot()).toEqual(existing);
        const failed = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        await pool.query(`create function app_private.fixture_reject_usage() returns trigger language plpgsql as $$ begin raise exception 'FIXTURE_FAILURE'; end $$;
          create trigger fixture_reject before insert on public.user_usage for each row execute function app_private.fixture_reject_usage()`);
        try {
          await expect(provision(failed)).rejects.toThrow("FIXTURE_FAILURE");
          for (const [table, key] of [
            ["app_private.local_principals", "id"],
            ["public.profiles", "id"],
            ["public.user_usage", "owner_id"],
          ]) {
            expect(
              (
                await pool.query(
                  `select count(*)::int n from ${table} where ${key}=$1`,
                  [failed],
                )
              ).rows,
            ).toEqual([{ n: 0 }]);
          }
        } finally {
          await pool.query(
            "drop trigger fixture_reject on public.user_usage; drop function app_private.fixture_reject_usage()",
          );
        }
        expect(await snapshot()).toEqual(existing);
      } finally {
        await blocker.query("rollback");
        blocker.release();
        a.release();
        b.release();
      }
    } finally {
      await pool.end();
      if (started)
        await run("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "stop"]);
      // Only this verified mkdtemp directory belongs to this test.
      if (
        !resolve(root).startsWith(
          resolve(".cache") + (process.platform === "win32" ? "\\" : "/"),
        )
      )
        throw Error("UNSAFE_FIXTURE_PATH");
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
