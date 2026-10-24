import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  DurableEvidenceSink,
  ProvisionalObservation,
} from "./provider-contracts";
import type { TrustedGatewayIdentity } from "./postgres-authority.server";
import {
  executorTransaction,
  type GatewayPostgresPool,
} from "./postgres-runtime.server";

/** One immutable intent and one immutable final observation per dispatch.
 * Stable keys permit identical retries and make conflicting final reports fail. */
function operationKey(observation: ProvisionalObservation) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "gateway-observation-v1",
        observation.intent.requestId,
        observation.intent.resourceId,
        observation.intent.dispatchGeneration,
        observation.state === "dispatch-intent" ? "intent" : "final",
      ]),
    )
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export class PostgresEvidence implements DurableEvidenceSink {
  constructor(
    private readonly pool: GatewayPostgresPool,
    private readonly identity: TrustedGatewayIdentity,
  ) {}

  async append(raw: ProvisionalObservation) {
    // Snapshot before awaiting; mutable callers cannot change the submitted scope.
    const payload = JSON.stringify(raw);
    if (Buffer.byteLength(payload) > 16384)
      throw new Error("INVALID_OBSERVATION");
    const observation: ProvisionalObservation = JSON.parse(payload);
    const trusted = await this.identity();
    const intent = observation.intent;
    if (
      trusted.ownerId !== intent.ownerId ||
      trusted.executorId !== intent.executorId
    )
      throw new Error("FORBIDDEN");
    return executorTransaction(this.pool, async (client) => {
      const result = await client.query(
        "SELECT public.ss_gateway_record_write_observation_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,$7::jsonb) AS receipt",
        [
          trusted.ownerId,
          intent.requestId,
          intent.resourceId,
          trusted.executorId,
          intent.epoch,
          operationKey(observation),
          payload,
        ],
      );
      return { receiptId: z.uuid().parse(result.rows[0]?.receipt) };
    });
  }
}
