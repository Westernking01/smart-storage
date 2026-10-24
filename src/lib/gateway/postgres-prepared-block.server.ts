import "server-only";
import type { TrustedGatewayIdentity } from "./postgres-authority.server";
import {
  executorTransaction,
  type GatewayPostgresPool,
} from "./postgres-runtime.server";
import {
  preparedBlockResolutionSchema,
  preparedBlockScopeSchema,
  type PreparedBlockAuthority,
  type PreparedBlockScope,
} from "./prepared-block.server";
import type {
  TrustedAuthorityResolver,
  WriteIntent,
} from "./provider-contracts";
import { intentSchema, permitSchema } from "./supabase-storage-provider.server";
import { canonical } from "../transfers/format";

/** Inject the SAME instance into PreparedBlockCloudBoundary and its provider.
 * Identity must come from fresh server verification and server executor config,
 * independently of scope/intent. No pools, credentials or routes are installed.
 * Lookup is advisory; consumeDispatch repeats every check under durable locks.
 */
export class PostgresPreparedBlockAuthority
  implements PreparedBlockAuthority, TrustedAuthorityResolver
{
  constructor(
    private readonly pool: GatewayPostgresPool,
    private readonly identity: TrustedGatewayIdentity,
  ) {}

  async resolve(raw: PreparedBlockScope) {
    const scope = preparedBlockScopeSchema.parse(raw);
    const trusted = await this.identity();
    if (!trusted.ownerId || scope.ownerId !== trusted.ownerId)
      throw new Error("FORBIDDEN");
    return executorTransaction(this.pool, async (client) => {
      const result = await client.query(
        "SELECT public.ss_registered_block_resolve_v1($1::uuid,$2::text,$3::text,$4::integer,$5::uuid) AS resolution",
        [
          trusted.ownerId,
          scope.checkpointId,
          scope.manifestSha256,
          scope.blockIndex,
          trusted.executorId,
        ],
      );
      const resolution = preparedBlockResolutionSchema.parse(
        result.rows[0]?.resolution,
      );
      if (
        canonical(resolution.scope) !== canonical(scope) ||
        resolution.intent.ownerId !== trusted.ownerId ||
        resolution.intent.executorId !== trusted.executorId ||
        resolution.reservation.ownerId !== trusted.ownerId ||
        resolution.reservation.sessionId !== resolution.intent.sessionId
      )
        throw new Error("IDENTITY_MISMATCH");
      return resolution;
    });
  }

  async consumeDispatch(raw: WriteIntent) {
    const intent = intentSchema.parse(raw);
    const trusted = await this.identity();
    if (
      !trusted.ownerId ||
      trusted.ownerId !== intent.ownerId ||
      trusted.executorId !== intent.executorId
    )
      throw new Error("FORBIDDEN");
    return executorTransaction(this.pool, async (client) => {
      const result = await client.query(
        "SELECT public.ss_registered_block_dispatch_v1($1::uuid,$2::uuid,$3::jsonb) AS permit",
        [trusted.ownerId, trusted.executorId, JSON.stringify(intent)],
      );
      const permit = permitSchema.parse(result.rows[0]?.permit);
      if (
        canonical(permit.intent) !== canonical(intent) ||
        permit.decisionId !== intent.requestId ||
        permit.writerId !== trusted.executorId ||
        permit.reservationId !== intent.sessionId ||
        permit.exposureId !== intent.resourceId ||
        permit.maximumEncodedBytes !== intent.declaredBytes ||
        permit.reservedExposureBytes < permit.maximumEncodedBytes ||
        permit.allowZeroBytes !== (intent.declaredBytes === 0)
      )
        throw new Error("INVALID_GRANT");
      return permit;
    });
  }
}
