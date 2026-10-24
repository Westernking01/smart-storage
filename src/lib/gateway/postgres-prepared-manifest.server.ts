import "server-only";
import { z } from "zod";
import { validateCheckpoint } from "../transfers/checkpoint";
import { canonical, fail } from "../transfers/format";
import { digest } from "../transfers/codec";
import type { TrustedGatewayIdentity } from "./postgres-authority.server";
import {
  executorTransaction,
  type GatewayPostgresPool,
} from "./postgres-runtime.server";

const registrationSchema = z
  .object({
    sessionId: z.guid(),
    fileId: z.guid(),
    bindings: z
      .array(
        z
          .object({
            attemptId: z.guid().optional(),
            requestId: z.guid(),
            resourceId: z.guid(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

/** Offline-only composition seam. Identity must be freshly verified server-side.
 * Optional attempt IDs select existing unclaimed attempts. Missing descriptors
 * are prepared atomically under the existing session hold. Request/resource IDs
 * name future claims, not authority. Registration never claims or dispatches.
 * A lost commit response rejects and leaves immutable plans/holds for reconciliation.
 */
export class PostgresPreparedManifestRegistration {
  constructor(
    private readonly pool: GatewayPostgresPool,
    private readonly identity: TrustedGatewayIdentity,
  ) {}

  async register(input: { checkpoint: unknown; reservation: unknown }) {
    const trusted = await this.identity();
    if (!trusted.ownerId || !trusted.executorId) fail("UNAUTHENTICATED");
    const checkpoint = validateCheckpoint(input.checkpoint);
    if (checkpoint.ownerId !== trusted.ownerId) fail("OWNER_FORBIDDEN");
    if (
      checkpoint.phase !== "prepared" ||
      !checkpoint.manifest ||
      checkpoint.blocks.some(
        (p) =>
          p.phase !== "prepared" ||
          p.attemptId !== null ||
          p.attemptedBytes !== 0 ||
          p.acknowledgedBytes !== 0,
      )
    )
      fail("PREPARED_BLOCK_REQUIRED");
    const manifest = checkpoint.manifest;
    if (
      manifest.blocks.some(
        (b) => b.codec === "raw" && b.originalSha256 !== b.encodedSha256,
      )
    )
      fail("INVALID_BLOCK");
    const reservation = registrationSchema.parse(input.reservation);
    const selectedAttempts = reservation.bindings
      .map((b) => b.attemptId)
      .filter((id) => id !== undefined);
    if (
      reservation.bindings.length !== manifest.blocks.length ||
      new Set(selectedAttempts).size !== selectedAttempts.length ||
      new Set(reservation.bindings.map((b) => b.requestId)).size !==
        reservation.bindings.length ||
      new Set(reservation.bindings.map((b) => b.resourceId)).size !==
        reservation.bindings.length
    )
      fail("INVALID_BINDINGS");
    const manifestText = canonical(manifest);
    const manifestSha256 = digest(new TextEncoder().encode(manifestText));
    await executorTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT public.ss_prepared_manifest_register_v1($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::uuid,$7::uuid,$8::jsonb)",
        [
          trusted.ownerId,
          trusted.executorId,
          checkpoint.id,
          manifestSha256,
          manifestText,
          reservation.sessionId,
          reservation.fileId,
          JSON.stringify(reservation.bindings),
        ],
      );
    });
    return {
      checkpointId: checkpoint.id,
      manifestSha256,
      blockCount: manifest.blocks.length,
    };
  }
}
