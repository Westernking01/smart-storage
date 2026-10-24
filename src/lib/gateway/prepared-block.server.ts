import "server-only";
import { z } from "zod";
import type { GatewayAuthentication } from "./core";
import {
  intentSchema,
  type SupabaseStorageProvider,
} from "./supabase-storage-provider.server";
import { recovery, validateCheckpoint } from "../transfers/checkpoint";
import { canonical, fail } from "../transfers/format";
import { digest, sourceHash } from "../transfers/codec";
import {
  parseDecimalBytes,
  type SessionState,
} from "../domain/control-contracts";
import type { WriteIntent } from "./provider-contracts";

export interface PreparedBlockScope {
  ownerId: string;
  checkpointId: string;
  manifestSha256: string;
  blockIndex: number;
}

/** Trusted server lookup only: resolve immutable membership, reservation and a
 * qualified total physical exposure bound, never client paths or quota claims.
 * Provider.consumeDispatch must atomically recheck these facts and consume the
 * one-use grant before I/O. A pending/consumed grant must never be reissued,
 * including under another request ID or after process restart.
 */
export interface PreparedBlockAuthority {
  resolve(scope: PreparedBlockScope): Promise<{
    scope: PreparedBlockScope;
    intent: WriteIntent;
    reservation: {
      ownerId: string;
      sessionId: string;
      state: SessionState;
      expiresAt: number;
      reservedBytes: string;
      requiredExposureBytes: string;
    };
  } | null>;
}

export const preparedBlockScopeSchema = z.object({
  ownerId: z.string().min(1),
  checkpointId: z.string().min(1),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  blockIndex: z.number().int().nonnegative(),
});
export const preparedBlockResolutionSchema = z.object({
  scope: preparedBlockScopeSchema,
  intent: intentSchema,
  reservation: z.object({
    ownerId: z.string().min(1),
    sessionId: z.string().min(1),
    state: z.enum(["reserved", "uploading"]),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reservedBytes: z.string(),
    requiredExposureBytes: z.string(),
  }),
});

/** Offline composition seam, with no route, credentials or runtime activation.
 * Accepts one complete staged block, never offsets/TUS. Results remain pending
 * independent reconciliation, even when the provider observed a response.
 */
export class PreparedBlockCloudBoundary {
  constructor(
    private readonly authentication: GatewayAuthentication,
    private readonly authority: PreparedBlockAuthority,
    private readonly provider: Pick<SupabaseStorageProvider, "write">,
    private readonly now: () => number = Date.now,
  ) {}

  async dispatch(input: {
    authorization?: string;
    checkpoint: unknown;
    blockIndex: number;
    staged: Blob;
  }) {
    if (!input.authorization?.trim()) fail("UNAUTHENTICATED");
    // The injected authenticator must freshly verify identity server-side.
    const identity = await this.authentication.authenticate({
      authorization: input.authorization,
    });
    if (!identity?.ownerId) fail("UNAUTHENTICATED");
    const checkpoint = validateCheckpoint(input.checkpoint);
    if (checkpoint.ownerId !== identity.ownerId) fail("OWNER_FORBIDDEN");
    if (
      checkpoint.phase !== "prepared" ||
      recovery(checkpoint).requiresRemoteReconciliation
    )
      fail("RECONCILIATION_REQUIRED");
    const progress = checkpoint.blocks[input.blockIndex];
    if (
      !Number.isSafeInteger(input.blockIndex) ||
      !progress ||
      !checkpoint.manifest ||
      progress.phase !== "prepared" ||
      progress.attemptedBytes !== 0 ||
      progress.acknowledgedBytes !== 0 ||
      progress.attemptId !== null
    )
      fail("PREPARED_BLOCK_REQUIRED");
    const block = progress.block;
    if (
      input.staged.size !== block.encodedBytes ||
      (await sourceHash(input.staged)) !== block.encodedSha256
    )
      fail("STAGED_INTEGRITY");
    const scope: PreparedBlockScope = {
      ownerId: identity.ownerId,
      checkpointId: checkpoint.id,
      manifestSha256: digest(
        new TextEncoder().encode(canonical(checkpoint.manifest)),
      ),
      blockIndex: input.blockIndex,
    };
    const parsed = preparedBlockResolutionSchema.safeParse(
      await this.authority.resolve(scope),
    );
    if (!parsed.success) fail("RESERVATION_INVALID");
    const { intent, reservation, scope: resolved } = parsed.data;
    if (
      canonical(resolved) !== canonical(scope) ||
      intent.ownerId !== identity.ownerId ||
      reservation.ownerId !== identity.ownerId ||
      reservation.sessionId !== intent.sessionId ||
      intent.declaredBytes !== block.encodedBytes ||
      intent.expectedSha256 !== block.encodedSha256 ||
      reservation.expiresAt <= this.now()
    )
      fail("RESERVATION_INVALID");
    const held = BigInt(parseDecimalBytes(reservation.reservedBytes));
    const required = BigInt(
      parseDecimalBytes(reservation.requiredExposureBytes),
    );
    if (required < BigInt(block.encodedBytes) || held < required)
      fail("QUOTA_INSUFFICIENT");
    const staged = input.staged;
    const bytes = (async function* () {
      for (let offset = 0; offset < staged.size; offset += 65_536)
        yield new Uint8Array(
          await staged.slice(offset, offset + 65_536).arrayBuffer(),
        );
    })();
    // Existing provider persists dispatch intent before transport and retains
    // holds on timeout, conflict, missing evidence or lost acknowledgments.
    const result = await this.provider.write(intent, bytes);
    return { state: "pending-reconciliation" as const, ...result };
  }
}
