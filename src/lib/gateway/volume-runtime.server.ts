import "server-only";
import { Pool } from "pg";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";
import { z } from "zod";
import {
  VolumeLifecycle,
  type VolumeDatabase,
} from "./volume-lifecycle.server";
import { LocalDiskTransport } from "./local-disk-transport.server";
import { backendConfig } from "../backend/config";

export function localVolumeEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  if (env.SMART_STORAGE_LOCAL_VOLUME_ENABLED !== "true") return false;
  const backend = backendConfig(env);
  if (
    !backend ||
    backend.environment !== "development" ||
    !["localhost", "127.0.0.1"].includes(new URL(backend.origin).hostname) ||
    env.SMART_STORAGE_TRANSFERS_ENABLED !== "false"
  )
    throw Error("LOCAL_VOLUME_CONFIGURATION_INVALID");
  return true;
}
let runtime: Promise<VolumeLifecycle> | undefined;
export async function volumeRuntime() {
  if (!localVolumeEnabled()) throw Error("LOCAL_VOLUME_DISABLED");
  if (!runtime)
    runtime = createRuntime().catch((error) => {
      runtime = undefined;
      throw error;
    });
  return runtime;
}
async function createRuntime() {
  const root = process.env.SMART_STORAGE_LOCAL_VOLUME_ROOT ?? "";
  const volumeId = z.uuid().parse(process.env.SMART_STORAGE_LOCAL_VOLUME_ID);
  const url = new URL(process.env.SMART_STORAGE_LOCAL_DATABASE_URL ?? "");
  if (
    !isAbsolute(root) ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/smart_storage_gateway_test" ||
    url.username !== "ss_volume_runtime" ||
    url.search ||
    url.hash
  )
    throw Error("LOCAL_VOLUME_CONFIGURATION_INVALID");
  for (const served of ["public", ".next", "src"]) {
    const rel = relative(resolve(served), resolve(root));
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw Error("UNSAFE_ROOT");
  }
  const stat = await lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await readFile(resolve(root, ".volume-id"), "utf8")).trim() !== volumeId
  )
    throw Error("VOLUME_MISMATCH");
  const pool = new Pool({
    connectionString: url.href,
    max: 4,
    connectionTimeoutMillis: 3000,
    query_timeout: 10000,
    application_name: "smart-storage-local-volume",
  });
  const db: VolumeDatabase = {
    async command(owner, action, id, data = {}) {
      const client = await pool.connect();
      let failed: Error | undefined;
      try {
        await client.query("begin isolation level read committed");
        const identity =
          await client.query(`select current_user=session_user and session_user='ss_volume_runtime'
          and current_database()='smart_storage_gateway_test'
          and inet_server_addr() in ('127.0.0.1'::inet,'::1'::inet)
          and not (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)
          as allowed from pg_roles where rolname=session_user`);
        if (identity.rows[0]?.allowed !== true)
          throw Error("RESTRICTED_RUNTIME_REQUIRED");
        await client.query("set local role ss_volume_gateway");
        const config = backendConfig(process.env);
        if (!config) throw Error("BACKEND_DISABLED");
        await client.query(
          "select set_config('smart_storage.local_issuer',$1,true)",
          [`${config.url}/auth/v1`],
        );
        const binding = await client.query(
          "select public.ss_volume_command($1,'binding',null,'{}'::jsonb) value",
          [owner],
        );
        if (binding.rows[0]?.value !== true)
          throw Error("ACCOUNT_SETUP_REQUIRED");
        const result = await client.query(
          "select public.ss_volume_command($1,$2,$3,$4::jsonb) value",
          [owner, action, id, JSON.stringify(data)],
        );
        await client.query("commit");
        return result.rows[0].value;
      } catch (error) {
        failed = Error("VOLUME_DATABASE_FAILURE");
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release(failed);
      }
    },
  };
  return new VolumeLifecycle(db, new LocalDiskTransport(root, 2), volumeId);
}
