import "server-only";
import { z } from "zod";
import { intentSchema } from "./supabase-storage-provider.server";
import { seededFixtureSchema } from "./seeded-fixture-contract";
import type { GatewayPostgresPool } from "./postgres-runtime.server";

export const inspectionSchema = z
  .object({
    operationId: z.uuid(),
    intent: intentSchema,
    scope: z
      .object({
        namespace: z.string().min(1).max(1024),
        uploadId: z.string().nullable(),
        version: z.string().nullable(),
        generation: z.string().nullable(),
      })
      .strict(),
    kind: z.enum(["metadata", "hash", "list"]),
    listing: z
      .object({
        prefix: z.string().min(1).max(1024),
        offset: z.literal(0),
        limit: z.literal(100),
      })
      .strict()
      .nullable(),
    phase: z.enum(["intent", "result"]),
    observedAt: z.iso.datetime(),
    direct: z
      .object({
        status: z.number().int().min(100).max(599).nullable(),
        bytes: z.number().int().nonnegative().nullable(),
        responseBytes: z.number().int().nonnegative().nullable(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        entries: z.number().int().min(0).max(100).nullable(),
      })
      .strict(),
    inference: z.enum([
      "pending",
      "matches",
      "mismatch",
      "incomplete",
      "unknown",
    ]),
    classification: z.literal("provisional"),
    retainHolds: z.literal(true),
    certified: z.literal(false),
    futureProviderEffectsPossible: z.literal(true),
  })
  .strict();
export type InspectionObservation = z.infer<typeof inspectionSchema>;
export const seededInspectionSchema = inspectionSchema.extend({
  intent: seededFixtureSchema,
});
export const anyInspectionSchema = z.union([
  inspectionSchema,
  seededInspectionSchema,
]);
export type AnyInspectionObservation = z.infer<typeof anyInspectionSchema>;
export interface InspectionSink {
  append(value: AnyInspectionObservation): Promise<unknown>;
}

/** Dedicated observer-capable restricted pool only. No executor/admin fallback.
 * SQL checks exact registered scope/epoch. Intent provenance is not authority. */
export class PostgresInspectionEvidence implements InspectionSink {
  constructor(
    private readonly pool: GatewayPostgresPool,
    private readonly owner: () => Promise<string>,
    private readonly registered: () => Promise<
      Pick<InspectionObservation, "intent" | "scope">
    >,
  ) {}
  async append(raw: unknown) {
    const value = inspectionSchema.parse(raw);
    const registered = await this.registered();
    const expected = inspectionSchema
      .pick({ intent: true, scope: true })
      .parse(registered);
    if (
      JSON.stringify({ intent: value.intent, scope: value.scope }) !==
      JSON.stringify(expected)
    )
      throw Error("REGISTERED_SCOPE_MISMATCH");
    if ((await this.owner()) !== value.intent.ownerId) throw Error("FORBIDDEN");
    const payload = JSON.stringify({
      scope: value.scope,
      kind: value.kind === "list" ? "listing" : "inspection",
      outcome: "ambiguous",
      observedAt: value.observedAt,
      observedBytes: value.direct.bytes,
      provenance: value,
      verifierRevision: "inspection-v1",
    });
    if (Buffer.byteLength(payload) > 16384) throw Error("EVIDENCE_LIMIT");
    const client = await this.pool.connect();
    let failed: Error | undefined;
    try {
      await client.query("BEGIN");
      const identity = await client.query(
        `SELECT session_user='ss_gateway_observer_runtime_test' AND current_user=session_user AND current_database()='smart_storage_gateway_test' AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432 AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS allowed FROM pg_catalog.pg_roles WHERE rolname=session_user`,
      );
      if (identity.rows.length !== 1 || identity.rows[0].allowed !== true)
        throw Error("RESTRICTED_OBSERVER_REQUIRED");
      await client.query("SET LOCAL ROLE ss_gateway_observer");
      const result = await client.query(
        "SELECT public.ss_gateway_record_receipt_v1($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::jsonb) AS receipt",
        [
          value.intent.ownerId,
          value.intent.resourceId,
          value.operationId,
          value.intent.epoch,
          payload,
        ],
      );
      const receiptId = z.uuid().parse(result.rows[0]?.receipt);
      await client.query("COMMIT");
      return { receiptId };
    } catch (error) {
      failed = Error("EVIDENCE_PERSISTENCE_FAILURE");
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release(failed);
    }
  }
}
