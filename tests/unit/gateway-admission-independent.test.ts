// Fresh disposable PostgreSQL cluster ONLY; never reads .env or pgpass files.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
import { LocalDiskTransport } from "../../src/lib/gateway/local-disk-transport.server";
import {
  VolumeLifecycle,
  type VolumeDatabase,
} from "../../src/lib/gateway/volume-lifecycle.server";
import { mkdir } from "node:fs/promises";

it.skipIf(!process.env.SMART_STORAGE_DISPOSABLE_PG_BIN)(
  "serializes real independent near-quota admissions and retains cancelled liability",
  async () => {
    const bin = process.env.SMART_STORAGE_DISPOSABLE_PG_BIN!;
    const root = await mkdtemp(resolve(".cache/adr041-pg-"));
    const cluster = join(root, "data");
    // Only this newly-created cluster, loopback-only on a distinct port.
    const port = 55441;
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("PG")) delete env[k];
    env.PGPASSFILE = join(root, "nonexistent-passfile");
    const run = (name: string, args: string[]) =>
      new Promise<void>((done, reject) => {
        const child = spawn(
          join(bin, name + (process.platform === "win32" ? ".exe" : "")),
          args,
          { env, windowsHide: true, stdio: "ignore" },
        );
        const timer = setTimeout(() => {
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
            new Error(`DISPOSABLE_POSTGRES_${name.toUpperCase()}_TIMEOUT`),
          );
        }, 30_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) done();
          else reject(new Error("DISPOSABLE_POSTGRES_COMMAND_FAILED"));
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
      const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await pool.query("insert into auth.users values($1)", [owner]);
      const claims = JSON.stringify({ sub: owner, role: "authenticated" });
      await pool.query("select set_config('request.jwt.claims',$1,false)", [
        claims,
      ]);
      await pool.query("select public.ss_bootstrap()");
      await pool.query(
        "update public.user_usage set quota_bytes=131172,max_slots=2",
      );
      const blocker = await pool.connect();
      await blocker.query("begin");
      await blocker.query(
        "select owner_id from public.user_usage where owner_id=$1 for update",
        [owner],
      );
      const reserve = async (key: string) => {
        const c = await pool.connect();
        try {
          await c.query("begin; set local role authenticated");
          await c.query("select set_config('request.jwt.claims',$1,true)", [
            claims,
          ]);
          const r = await c.query(
            "select public.ss_reserve($1,'file.bin',null,100,$2) value",
            [key, "a".repeat(64)],
          );
          await c.query("commit");
          return r.rows[0].value;
        } catch (error) {
          await c.query("rollback");
          throw error;
        } finally {
          c.release();
        }
      };
      const competing = Promise.allSettled([
        reserve("concurrent_key_0001"),
        reserve("concurrent_key_0002"),
      ]);
      let overlapping = false;
      try {
        for (let n = 0; n < 100; n++) {
          const r = await pool.query(
            "select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select public.ss_reserve%'",
          );
          if (r.rows[0].n === 2) {
            overlapping = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        await blocker.query("rollback");
        blocker.release();
      }
      const results = await competing;
      expect(overlapping).toBe(true);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const success = results.find((r) => r.status === "fulfilled")!;
      if (success.status !== "fulfilled") throw Error("NO_ADMISSION");
      const id = success.value.id;
      expect(
        (
          await pool.query(
            "select reserved_bytes::text,active_slots from public.user_usage",
          )
        ).rows,
      ).toEqual([{ reserved_bytes: "131172", active_slots: 1 }]);
      expect(
        (
          await pool.query(
            "select count(*)::int n from app_private.gateway_sessions",
          )
        ).rows[0].n,
      ).toBe(1);
      const cancelling = await pool.connect();
      try {
        await cancelling.query("begin;set local role authenticated");
        await cancelling.query(
          "select set_config('request.jwt.claims',$1,true)",
          [claims],
        );
        await cancelling.query("select public.ss_cancel($1)", [id]);
        await cancelling.query("commit");
      } finally {
        cancelling.release();
      }
      expect(
        (
          await pool.query(
            "select held_bytes::text,slot_held from public.upload_sessions where id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual({ held_bytes: "131172", slot_held: true });
      await expect(reserve("concurrent_key_0003")).rejects.toThrow();

      // The new local-volume lifecycle uses the same account lock/reservation
      // and exercises real independent transactions, not an embedded queue.
      const volumeOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await pool.query("insert into auth.users values($1)", [volumeOwner]);
      const setup = await pool.connect();
      try {
        await setup.query("begin");
        await setup.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: volumeOwner, role: "authenticated" }),
        ]);
        await setup.query("select public.ss_bootstrap()");
        await setup.query(
          "update public.user_usage set quota_bytes=131172,max_slots=2 where owner_id=$1",
          [volumeOwner],
        );
        await setup.query("commit");
      } finally {
        setup.release();
      }
      const database: VolumeDatabase = {
        async command(owner, action, id, data = {}) {
          const c = await pool.connect();
          try {
            await c.query("begin;set local role ss_volume_gateway");
            const r = await c.query(
              "select public.ss_volume_command($1,$2,$3,$4::jsonb) value",
              [owner, action, id, JSON.stringify(data)],
            );
            await c.query("commit");
            return r.rows[0].value;
          } catch (error) {
            await c.query("rollback");
            throw error;
          } finally {
            c.release();
          }
        },
      };
      const volumeRoot = join(root, "volume");
      await mkdir(volumeRoot);
      const lifecycle = new VolumeLifecycle(
        database,
        new LocalDiskTransport(volumeRoot, 2),
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      );
      const bytes = Buffer.alloc(100, 42),
        sha = createHash("sha256").update(bytes).digest("hex");
      const input = {
        key: "volume_concurrent_0001",
        metadata: { originalName: "file.bin", originalMime: null },
        manifest: {
          format: "compression-spike",
          version: 1,
          blockSize: 8388608,
          originalBytes: 100,
          originalSha256: sha,
          blocks: [
            {
              index: 0,
              offset: 0,
              originalBytes: 100,
              encodedBytes: 100,
              codec: "raw",
              originalSha256: sha,
              encodedSha256: sha,
            },
          ],
        },
      };
      const locked = await pool.connect();
      await locked.query("begin");
      await locked.query(
        "select owner_id from public.user_usage where owner_id=$1 for update",
        [volumeOwner],
      );
      const admissions = Promise.allSettled([
        lifecycle.begin(volumeOwner, input),
        lifecycle.begin(volumeOwner, {
          ...input,
          key: "volume_concurrent_0002",
        }),
      ]);
      let volumeOverlap = false;
      try {
        for (let n = 0; n < 100; n++) {
          const r = await pool.query(
            "select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select public.ss_volume_command%'",
          );
          if (r.rows[0].n === 2) {
            volumeOverlap = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        await locked.query("rollback");
        locked.release();
      }
      const admitted = await admissions;
      expect(volumeOverlap).toBe(true);
      expect(admitted.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const denied = admitted.find((r) => r.status === "rejected");
      expect(denied?.status === "rejected" && denied.reason.message).toBe(
        "QUOTA_EXCEEDED",
      );
      const accepted = admitted.find((r) => r.status === "fulfilled");
      if (!accepted || accepted.status !== "fulfilled")
        throw Error("NO_VOLUME_ADMISSION");
      const session = accepted.value;
      // Concurrent same-object writes: exactly one durable dispatch and one
      // filesystem object; no retry or duplicate quota charge.
      const body = async function* () {
        yield bytes;
      };
      const writes = await Promise.allSettled([
        lifecycle.upload(
          volumeOwner,
          session.id,
          0,
          body(),
          new AbortController().signal,
        ),
        lifecycle.upload(
          volumeOwner,
          session.id,
          0,
          body(),
          new AbortController().signal,
        ),
      ]);
      expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (await lifecycle.status(volumeOwner, session.id)).objects[0].receiptId,
      ).toBeTruthy();
      // Publication versus cancellation must serialize under the account lock.
      const ending = await Promise.allSettled([
        lifecycle.publish(volumeOwner, session.id),
        lifecycle.cancel(volumeOwner, session.id),
      ]);
      expect(ending.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const final = await lifecycle.status(volumeOwner, session.id);
      expect(["completed", "settled"]).toContain(final.state);
      const counters = (
        await pool.query(
          "select stored_bytes::text,reserved_bytes::text,active_slots from public.user_usage where owner_id=$1",
          [volumeOwner],
        )
      ).rows[0];
      expect(counters.reserved_bytes).toBe("0");
      expect(counters.active_slots).toBe(0);
      if (final.state === "completed") {
        expect(Number(counters.stored_bytes)).toBeGreaterThanOrEqual(
          bytes.length,
        );
        await lifecycle.delete(volumeOwner, session.id);
        await lifecycle.delete(volumeOwner, session.id);
      } else expect(counters.stored_bytes).toBe("0");
      expect(
        (
          await pool.query(
            "select stored_bytes::text from public.user_usage where owner_id=$1",
            [volumeOwner],
          )
        ).rows[0].stored_bytes,
      ).toBe("0");
    } finally {
      await pool.end();
      if (started)
        await run("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "stop"]);
      // Exact mkdtemp target owned by this test; no existing test state is touched.
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
