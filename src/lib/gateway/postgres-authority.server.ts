import "server-only";
import type {
  TrustedAuthorityResolver,
  WriteIntent,
} from "./provider-contracts";
import { intentSchema, permitSchema } from "./supabase-storage-provider.server";
import {
  executorTransaction,
  type GatewayPostgresPool,
} from "./postgres-runtime.server";

/** Trusted backend assertion, obtained independently of the caller's intent.
 * Do not expose this binding to browser-provided owner/executor assertions. */
export type TrustedGatewayIdentity = () => Promise<
  Readonly<{ ownerId: string; executorId: string }>
>;

export class PostgresAuthority implements TrustedAuthorityResolver {
  constructor(
    private readonly pool: GatewayPostgresPool,
    private readonly identity: TrustedGatewayIdentity,
  ) {}

  async consumeDispatch(raw: WriteIntent) {
    const intent = intentSchema.parse(raw);
    const trusted = await this.identity();
    if (
      trusted.ownerId !== intent.ownerId ||
      trusted.executorId !== intent.executorId
    )
      throw new Error("FORBIDDEN");
    return executorTransaction(this.pool, async (client) => {
      const result = await client.query(
        "SELECT public.ss_gateway_resolve_dispatch_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::bigint) AS permit",
        [
          trusted.ownerId,
          intent.requestId,
          intent.resourceId,
          trusted.executorId,
          intent.epoch,
          intent.dispatchGeneration,
        ],
      );
      const permit = permitSchema.parse(result.rows[0]?.permit);
      if (
        Object.keys(intent).some(
          (key) =>
            intent[key as keyof WriteIntent] !==
            permit.intent[key as keyof WriteIntent],
        )
      )
        throw new Error("IDENTITY_MISMATCH");
      if (
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
