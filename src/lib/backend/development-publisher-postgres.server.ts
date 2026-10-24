import "server-only";
import { Pool, type PoolConfig, type PoolClient } from "pg";
import { z } from "zod";
import { developmentUserVerifier } from "./development-user-verifier.server";

const role = "ss_dev_cloud_publisher";
const login = "ss_dev_cloud_publisher_login";
const contracts: Record<string, [string, string[]]> = {
  ss_begin_attempt_request: [
    "uuid,bigint,uuid,bigint",
    ["p_attempt", "p_epoch", "p_request", "p_body"],
  ],
  ss_finish_attempt_request: ["uuid,bigint", ["p_request", "p_offset"]],
  ss_record_observation: [
    "uuid,bigint,bigint",
    ["p_attempt", "p_epoch", "p_size"],
  ],
  ss_finalize_verified: [
    "uuid,jsonb,bigint,text,text",
    ["p_session", "p_manifest", "p_size", "p_sha256", "p_path"],
  ],
};

// Parse separately: pg connection-string SSL options must never override TLS.
export function publisherPoolConfig(raw: string): PoolConfig {
  try {
    const url = new URL(raw);
    const user = decodeURIComponent(url.username);
    const endpointAllowed =
      (url.hostname === "db.fneuqneqaopkmpeevlqz.supabase.co" &&
        user === login) ||
      (url.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
        user === login + ".fneuqneqaopkmpeevlqz");
    if (
      url.protocol !== "postgresql:" ||
      !endpointAllowed ||
      url.port !== "5432" ||
      url.pathname !== "/postgres" ||
      url.search ||
      url.hash ||
      !url.password
    )
      throw Error("DEV_PUBLISHER_CONNECTION_INVALID");
    return {
      host: url.hostname,
      port: 5432,
      database: "postgres",
      user,
      password: decodeURIComponent(url.password),
      ssl: {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: url.hostname,
      },
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      statement_timeout: 10000,
      query_timeout: 12000,
      idle_in_transaction_session_timeout: 10000,
      application_name: "smart-storage-dev-publisher",
    };
  } catch {
    // URL/decode exceptions can retain the input, including a password.
    throw Error("DEV_PUBLISHER_CONNECTION_INVALID");
  }
}

let pool: Pool | undefined;
export function publisherPool(raw: string) {
  if (!pool) {
    pool = new Pool(publisherPoolConfig(raw));
    // Do not log connection details or let an idle socket error crash the server.
    pool.on("error", () => {});
  }
  return pool;
}

// Fixed setup shared by publication and the isolated read-only qualification.
async function publisherContext(
  client: PoolClient,
  verify: () => Promise<string>,
  owner: string,
  readOnly = false,
) {
  await client.query("DISCARD ALL");
  await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
  await client.query("SET LOCAL search_path=pg_catalog");
  if (z.uuid().parse(await verify()) !== owner)
    throw Error("DEV_PUBLISHER_IDENTITY_CHANGED");
  const identity = await client.query("SELECT session_user AS login");
  if (identity.rows[0]?.login !== login)
    throw Error("DEV_PUBLISHER_LOGIN_INVALID");
  await client.query("SET LOCAL ROLE ss_dev_cloud_publisher");
  await client.query(
    "SELECT set_config('request.jwt.claim', '', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true), set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ sub: owner, role, is_anonymous: false })],
  );
}

/** Offline-prepared qualification entry only. Supply the trusted server Auth
 * client and dedicated publisher pool; accepts no subject, role, claims or SQL.
 * Deliberately separate from trusted() and all application runtime selection. */
export async function postgresPublisherIdentityProbe(
  db: Pick<Pool, "connect">,
  auth: Parameters<typeof developmentUserVerifier>[0],
) {
  let client: PoolClient | undefined;
  let failed = true;
  let rollbackAttempted = false;
  let category = "AUTH_VALIDATION_FAILED";
  try {
    const identity = await developmentUserVerifier(auth);
    category = "DATABASE_CONNECTION_FAILED";
    client = await db.connect();
    category = "DATABASE_CONTEXT_FAILED";
    await publisherContext(
      client,
      async () => {
        try {
          return await identity.verify();
        } catch {
          category = "AUTH_VALIDATION_FAILED";
          throw Error();
        }
      },
      identity.id,
      true,
    );
    const expected = JSON.stringify({
      sub: identity.id,
      role,
      is_anonymous: false,
    });
    const result = await client.query(
      "SELECT session_user AS login, current_user AS role, pg_catalog.current_setting('transaction_read_only') AS read_only, pg_catalog.current_setting('request.jwt.claims',true)::pg_catalog.jsonb = $1::pg_catalog.jsonb AS context_matches, nullif(pg_catalog.current_setting('request.jwt.claim',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim.role',true),'') IS NULL AS legacy_clear, public.ss_dev_cloud_enrolled() AS enrolled",
      [expected],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row.login !== login ||
      row.role !== role ||
      row.read_only !== "on" ||
      row.context_matches !== true ||
      row.legacy_clear !== true
    )
      throw Error();
    // Only a definite FALSE with otherwise valid context is enrollment denial.
    if (row.enrolled === false) {
      category = "ENROLLMENT_DENIED";
      throw Error();
    }
    if (row.enrolled !== true) throw Error();
    category = "CLEANUP_FAILED";
    rollbackAttempted = true;
    await client.query("ROLLBACK");
    const cleanup = await client.query(
      "SELECT session_user AS login, current_user AS role, nullif(pg_catalog.current_setting('request.jwt.claims',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),'') IS NULL AND nullif(pg_catalog.current_setting('request.jwt.claim.role',true),'') IS NULL AS clean",
    );
    const clean = cleanup.rows[0];
    if (
      cleanup.rows.length !== 1 ||
      clean.login !== login ||
      clean.role !== login ||
      clean.clean !== true
    )
      throw Error();
    failed = false;
    return { verified: true as const };
  } catch {
    if (client && !rollbackAttempted)
      await client.query("ROLLBACK").catch(() => {
        category = "CLEANUP_FAILED";
      });
    throw Object.assign(Error("DEV_PUBLISHER_PROBE_FAILED"), {
      qualificationCategory: category,
    });
  } finally {
    try {
      client?.release(failed);
    } catch {
      throw Object.assign(Error("DEV_PUBLISHER_PROBE_FAILED"), {
        qualificationCategory: "CLEANUP_FAILED",
      });
    }
  }
}

/** Identity comes only from an ordinary session verifier, never RPC arguments.
 * No callback receives the raw connection; all SQL identifiers are fixed here. */
export function postgresPublisher(
  db: Pick<Pool, "connect">,
  verify: () => Promise<string>,
) {
  const ensureTrusted = async () => {
    z.uuid().parse(await verify());
  };
  const trusted = async (name: string, args: Record<string, unknown>) => {
    const contract = Object.hasOwn(contracts, name)
      ? contracts[name]
      : undefined;
    if (
      !contract ||
      Object.keys(args).length !== contract[1].length ||
      contract[1].some((key) => !Object.hasOwn(args, key))
    )
      throw Error("DEV_PUBLISHER_RPC_INVALID");
    const owner = z.uuid().parse(await verify());
    const client = await db.connect();
    // Destroy on every error, including uncertain COMMIT; never retry publication.
    let failed = true;
    try {
      // Dedicated connections only. Reset role, claims, search_path and every
      // other session setting left by a prior checkout before entering a txn.
      await publisherContext(client, verify, owner);
      const casts = contract[0].split(",");
      const values = contract[1].map((key, index) =>
        casts[index] === "jsonb" ? JSON.stringify(args[key]) : args[key],
      );
      const result = await client.query(
        `SELECT public.${name}(${casts.map((cast, i) => `$${i + 1}::${cast}`).join(",")}) AS result`,
        values,
      );
      await client.query("COMMIT");
      failed = false;
      return result.rows[0]?.result;
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      throw Error("CLOUD_TRUSTED_RPC_UNAVAILABLE");
    } finally {
      client.release(failed);
    }
  };
  return { trusted, ensureTrusted };
}
