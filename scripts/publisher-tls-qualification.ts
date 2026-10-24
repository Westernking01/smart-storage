import { readFileSync } from "node:fs";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import { Client, type ClientConfig } from "pg";
import { publisherPoolConfig } from "../src/lib/backend/development-publisher-postgres.server";

const host = "aws-0-eu-west-1.pooler.supabase.com";
export function qualificationConfig(
  env: Record<string, string | undefined>,
): ClientConfig {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || env.NODE_OPTIONS)
    throw Error("QUALIFICATION_ENV_INVALID");
  for (const name of [
    "SMART_STORAGE_TRANSFERS_ENABLED",
    "SMART_STORAGE_DEV_CLOUD_ENABLED",
  ])
    if (env[name] !== "false") throw Error("QUALIFICATION_FLAGS_INVALID");
  const config = publisherPoolConfig(
    env.SMART_STORAGE_DEV_CLOUD_DATABASE_URL ?? "",
  );
  if (config.host !== host || !env.SMART_STORAGE_PUBLISHER_CA_FILE)
    throw Error("QUALIFICATION_CONFIG_INVALID");
  const ca = readFileSync(env.SMART_STORAGE_PUBLISHER_CA_FILE, "utf8");
  if (!ca.includes("-----BEGIN CERTIFICATE-----"))
    throw Error("QUALIFICATION_CA_INVALID");
  return {
    ...config,
    ssl: {
      ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: host,
      checkServerIdentity,
    },
    application_name: "smart-storage-publisher-readonly-qualification",
  };
}

// Fixed reviewed SQL only. No operator SQL, RPC names, subjects or file payloads.
export function qualificationSql() {
  const base = new URL("../supabase/development-cloud/", import.meta.url);
  const preflight = readFileSync(
    new URL("publisher-preflight.readonly.sql", base),
    "utf8",
  );
  const audit = readFileSync(
    new URL("publisher-permissions.assert.sql", base),
    "utf8",
  );
  return preflight
    .replace(/^\\ir publisher-permissions.assert.sql\r?$/m, audit)
    .replace(/^\\.*\r?\n/gm, "")
    .replace("DISCARD ALL;", "");
}

export async function qualify(
  client: Pick<Client, "connect" | "query" | "end"> & {
    connection?: { stream: TLSSocket };
  },
  sql: string,
) {
  try {
    await client.connect();
    const socket = client.connection?.stream;
    const protocol = socket?.getProtocol?.();
    if (
      !socket?.encrypted ||
      !socket.authorized ||
      socket.authorizationError ||
      !["TLSv1.2", "TLSv1.3"].includes(protocol ?? "") ||
      checkServerIdentity(host, socket.getPeerCertificate())
    )
      throw Error("QUALIFICATION_TLS_INVALID");
    await client.query("DISCARD ALL");
    await client.query(sql);
    return protocol;
  } finally {
    // Close this dedicated client on success and every failure; never return it to a pool.
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

if (process.argv[2] === "--execute") {
  try {
    const config = qualificationConfig(process.env);
    const sql = qualificationSql();
    delete process.env.SMART_STORAGE_DEV_CLOUD_DATABASE_URL;
    const protocol = await qualify(
      new Client(config) as Client & { connection: { stream: TLSSocket } },
      sql,
    );
    console.log(
      `PASS: Node client ${protocol}; verified CA/hostname, login, permissions, local role/claims and rollback cleanup.`,
    );
  } catch {
    // Driver errors can contain credentials, paths or server data.
    console.error(
      "FAIL: publisher read-only qualification; stop without retry or activation.",
    );
    process.exitCode = 1;
  }
}
