import "server-only";
import { z } from "zod";
import {
  seededFixtureSchema,
  type SeededFixture,
} from "./seeded-fixture-contract";
import {
  seededInspectionSchema,
  type InspectionSink,
} from "./inspection-evidence.server";
import type {
  GatewayPostgresClient,
  GatewayPostgresPool,
} from "./postgres-runtime.server";
import type { InspectionTarget } from "./inspection-runner.server";
import { FileProbeFence } from "./probe-fence.server";

async function transaction<T>(
  pool: GatewayPostgresPool,
  role: "observer" | "administrator",
  work: (client: GatewayPostgresClient) => Promise<T>,
) {
  const client = await pool.connect();
  let failed: Error | undefined;
  try {
    await client.query("BEGIN");
    const identity = await client.query(
      role === "observer"
        ? `SELECT session_user='ss_gateway_observer_runtime_test' AND current_user=session_user AND current_database()='smart_storage_gateway_test' AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432 AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS allowed FROM pg_catalog.pg_roles WHERE rolname=session_user`
        : `SELECT session_user='postgres' AND current_user=session_user AND current_database()='smart_storage_gateway_test' AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432 AS allowed`,
    );
    if (identity.rows.length !== 1 || identity.rows[0].allowed !== true)
      throw Error("RESTRICTED_SEEDED_DATABASE_REQUIRED");
    if (role === "observer")
      await client.query("SET LOCAL ROLE ss_gateway_observer");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failed = Error("SEEDED_DATABASE_FAILURE");
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release(failed);
  }
}

/** Explicit local operator action. No credentials, retries, IDs or remote fallback.
 * Exact fixture fields are fixed in SQL; the DB generates the registration UUID.
 * A lost acknowledgment must be investigated, never automatically retried. */
export async function registerSeededFixture(
  pool: GatewayPostgresPool,
  input: {
    authorized: true;
    verificationReference: string;
    expiresAt: number;
  },
) {
  z.object({
    authorized: z.literal(true),
    verificationReference: z.string().min(1).max(256),
    expiresAt: z.number().int().positive(),
  })
    .strict()
    .parse(input);
  if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 1800000)
    throw Error("REGISTRATION_UNAUTHORIZED");
  return transaction(pool, "administrator", async (client) => {
    const result = await client.query(
      "SELECT public.ss_seeded_fixture_register_v1($1::text,$2::timestamptz) AS registration",
      [input.verificationReference, new Date(input.expiresAt).toISOString()],
    );
    return z.uuid().parse(result.rows[0]?.registration);
  });
}

/** Owner is supplied by a trusted server identity resolver, never the target or
 * provider object's owner metadata. This resolves inspection authority only. */
export class SeededFixtureObserver implements InspectionSink {
  constructor(
    private readonly pool: GatewayPostgresPool,
    private readonly owner: () => Promise<string>,
    private readonly registrationId: string,
  ) {
    z.uuid().parse(registrationId);
  }
  private async binding(client: GatewayPostgresClient) {
    const owner = await this.owner();
    if (owner !== "310d0ec8-84ca-423a-b646-0480a20edc09")
      throw Error("FORBIDDEN");
    const result = await client.query(
      "SELECT public.ss_seeded_fixture_resolve_v1($1::uuid,$2::uuid) AS fixture",
      [this.registrationId, owner],
    );
    const fixture = seededFixtureSchema.parse(result.rows[0]?.fixture);
    if (
      fixture.registrationId !== this.registrationId ||
      fixture.ownerId !== owner ||
      fixture.expiresAt <= Date.now()
    )
      throw Error("STALE_SEEDED_REGISTRATION");
    return fixture;
  }
  async resolve(): Promise<SeededFixture> {
    return transaction(this.pool, "observer", (client) => this.binding(client));
  }
  async append(raw: unknown) {
    const value = seededInspectionSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(value)) > 16384)
      throw Error("EVIDENCE_LIMIT");
    return transaction(this.pool, "observer", async (client) => {
      const fixture = await this.binding(client);
      if (JSON.stringify(value.intent) !== JSON.stringify(fixture))
        throw Error("REGISTERED_SCOPE_MISMATCH");
      const result = await client.query(
        "SELECT public.ss_seeded_fixture_receipt_v1($1::uuid,$2::uuid,$3::jsonb) AS receipt",
        [fixture.registrationId, fixture.ownerId, JSON.stringify(value)],
      );
      return { receiptId: z.uuid().parse(result.rows[0]?.receipt) };
    });
  }
}

/** Supply to the existing authenticated host's runProbe. No second runner,
 * credential source, activation switch or dispatch/write capability. */
export async function composeSeededFixtureProbe(options: {
  observerPool: GatewayPostgresPool;
  trustedOwner: () => Promise<string>;
  registrationId: string;
  evidenceDirectory: string;
  restrictedAclReviewed: true;
}) {
  if (options.restrictedAclReviewed !== true)
    throw Error("RESTRICTED_EVIDENCE_ACL_REQUIRED");
  if (
    options.evidenceDirectory !==
    "C:\\Users\\Admin\\Desktop\\NEW\\smart-storage-probe-evidence"
  )
    throw Error("RESTRICTED_EVIDENCE_DESTINATION_REQUIRED");
  const sink = new SeededFixtureObserver(
    options.observerPool,
    options.trustedOwner,
    options.registrationId,
  );
  const fixture = await sink.resolve();
  const target: InspectionTarget = {
    project: fixture.project,
    endpoint: `https://${fixture.project}.supabase.co/storage/v1`,
    prefix: "gateway-probe/v1",
    intent: fixture,
    scope: {
      namespace: fixture.project,
      uploadId: null,
      version: null,
      generation: null,
    },
  };
  return {
    target,
    sink,
    resolveSeeded: () => sink.resolve(),
    fence: new FileProbeFence(options.evidenceDirectory),
    destinations: {
      observer: "postgresql://127.0.0.1:5432/smart_storage_gateway_test",
      observerRole: "ss_gateway_observer_runtime_test",
      evidenceDirectory: options.evidenceDirectory,
      restrictedAclReviewed: options.restrictedAclReviewed,
    },
  };
}
