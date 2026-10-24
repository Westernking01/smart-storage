import { readFile, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import {
  maskedInput,
  confirmHidden,
  HiddenInputError,
} from "./probe-auth-host-cli";
import {
  executeSeededProbe,
  preflightSeededProbe,
  seededEvidenceDirectory,
  type SeededProbeManifests,
} from "../../src/lib/gateway/seeded-probe-host.server";
import type { GatewayPostgresPool } from "../../src/lib/gateway/postgres-runtime.server";

/** Fixed local target and explicit passwords: never pg environment/passfile defaults. */
export function createLocalPool(
  user: "postgres" | "ss_gateway_observer_runtime_test",
  password: string,
) {
  if (!password || password.length > 2048)
    throw Error("DATABASE_INPUT_REJECTED");
  const pool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    database: "smart_storage_gateway_test",
    user,
    password,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    lock_timeout: 5000,
    options: "-c search_path=",
    application_name: "smart-storage-seeded-read-only",
  });
  pool.on("error", () => {
    /* Never print connection/error objects. */
  });
  const adapter: GatewayPostgresPool = {
    async connect() {
      const client = await pool.connect();
      return {
        query: async (sql, values) => {
          const result = await client.query(sql, values);
          return { rows: result.rows as Record<string, unknown>[] };
        },
        release: (error) => client.release(error),
      };
    },
  };
  return { pool, adapter };
}

export async function validateLocalEvidence() {
  if (process.platform !== "win32")
    throw Error("WINDOWS_OPERATOR_HOST_REQUIRED");
  const stat = await lstat(seededEvidenceDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("EVIDENCE_DIRECTORY_REJECTED");
  // Inspect ACL metadata only; no credential or evidence-file contents are read.
  const script = `$ErrorActionPreference='Stop'
$p='C:\\Users\\Admin\\Desktop\\NEW\\smart-storage-probe-evidence'
$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed=@($me,'S-1-5-18','S-1-5-32-544')
$item=Get-Item -LiteralPath $p
while ($null -ne $item) {
 if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse' }
 $item=$item.Parent
}
$acl=Get-Acl -LiteralPath $p
if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Owner' }
foreach ($ace in $acl.Access) {
 $sid=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
 if ($ace.AccessControlType -eq 'Allow' -and $allowed -notcontains $sid) { throw 'BroadAccess' }
}
Write-Output 'PASS'`;
  const result = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 10000, windowsHide: true },
  );
  if (result.stdout.trim() !== "PASS") throw Error("EVIDENCE_ACL_REJECTED");
}

async function openPools() {
  const admin = createLocalPool(
    "postgres",
    await maskedInput("Local postgres password (hidden): "),
  );
  let observer: ReturnType<typeof createLocalPool> | undefined;
  try {
    observer = createLocalPool(
      "ss_gateway_observer_runtime_test",
      await maskedInput("Local restricted observer password (hidden): "),
    );
    const restricted = observer;
    return {
      administrator: admin.adapter,
      observer: restricted.adapter,
      async verify() {
        for (const [connection, user] of [
          [admin, "postgres"],
          [restricted, "ss_gateway_observer_runtime_test"],
        ] as const) {
          const client = await connection.pool.connect();
          let failure: Error | undefined;
          try {
            const result = await client.query(
              `SELECT session_user=$1 AND current_user=session_user
              AND current_database()='smart_storage_gateway_test'
              AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432
              AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999
              AND ($1='postgres' OR NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)) AS allowed
              FROM pg_catalog.pg_roles WHERE rolname=session_user`,
              [user],
            );
            if (result.rows.length !== 1 || result.rows[0].allowed !== true)
              throw Error("LOCAL_IDENTITY_REJECTED");
            if (user !== "postgres") {
              await client.query("BEGIN");
              await client.query("SET LOCAL ROLE ss_gateway_observer");
              const privileges = await client.query(`SELECT
                has_function_privilege(current_user,'public.ss_seeded_fixture_resolve_v1(uuid,uuid)','EXECUTE')
                AND has_function_privilege(current_user,'public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb)','EXECUTE')
                AND NOT has_function_privilege(current_user,'public.ss_seeded_fixture_register_v1(text,timestamptz)','EXECUTE')
                AND NOT has_schema_privilege(current_user,'app_private','USAGE') AS allowed`);
              if (
                privileges.rows.length !== 1 ||
                privileges.rows[0].allowed !== true
              )
                throw Error("OBSERVER_COMPOSITION_REJECTED");
              await client.query("ROLLBACK");
            } else {
              const privileges =
                await client.query(`SELECT has_function_privilege(
                current_user,'public.ss_seeded_fixture_register_v1(text,timestamptz)','EXECUTE') AS allowed`);
              if (
                privileges.rows.length !== 1 ||
                privileges.rows[0].allowed !== true
              )
                throw Error("REGISTRATION_COMPOSITION_REJECTED");
            }
          } catch {
            failure = Error("LOCAL_COMPOSITION_REJECTED");
            throw failure;
          } finally {
            client.release(failure);
          }
        }
      },
      async close() {
        await Promise.all([admin.pool.end(), restricted.pool.end()]);
      },
    };
  } catch {
    await admin.pool.end();
    if (observer) await observer.pool.end();
    throw Error("LOCAL_POOL_PREPARATION_FAILED");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || !["--dry-run", "--execute"].includes(args[0]))
    throw Error("DISABLED");
  if (
    process.execArgv.some((v) => /inspect|debug/.test(v)) ||
    /inspect|debug/.test(process.env.NODE_OPTIONS ?? "")
  )
    throw Error("DEBUGGER_FORBIDDEN");
  const manifests = await Promise.all(
    args
      .slice(1)
      .map(
        async (path) =>
          JSON.parse(
            (await readFile(path, "utf8")).replace(/^\uFEFF/, ""),
          ) as unknown,
      ),
  );
  const [plan, review, authAuthorization, config, storageAuthorization] =
    manifests;
  const m: SeededProbeManifests = {
    plan,
    review,
    authAuthorization,
    config,
    storageAuthorization,
  };
  const initial = preflightSeededProbe(m);
  await validateLocalEvidence();
  if (args[0] === "--dry-run") {
    process.stdout.write(
      "PASS offline manifests and local evidence ACLs. No credentials, database or provider contact.\n",
    );
    return;
  }
  await executeSeededProbe(m, {
    validateLocal: validateLocalEvidence,
    confirm: (id, phase) =>
      confirmHidden(
        `${phase === "registration" ? "Register ONCE now; no recovery/replay" : "Authorize bounded execution"}: type ${id} (hidden): `,
        id,
        phase === "registration"
          ? "registration-confirmation"
          : id === initial.auth.authorizationId
            ? "auth-confirmation"
            : "execution-confirmation",
      ),
    openPools,
    readMaskedCredentials: async () => ({
      apiKey: await maskedInput("Disposable publishable key (hidden): "),
      email: await maskedInput("Dedicated user email (hidden): "),
      password: await maskedInput("Dedicated user password (hidden): "),
    }),
  });
  process.stdout.write(
    "Read-only sequence completed; observations remain provisional.\n",
  );
}
if (require.main === module)
  void main().catch((error: unknown) => {
    if (error instanceof HiddenInputError && error.stage)
      process.stderr.write(
        `Seeded probe input failure: stage=${error.stage} reason=${error.reason}\n`,
      );
    process.stderr.write(
      "Seeded probe halted. Preserve registration, claims and receipts; no automatic retry or recovery.\n",
    );
    process.exitCode = 1;
  });
