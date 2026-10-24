import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  DurableEvidenceSink,
  ProvisionalObservation,
  StorageTransport,
  TransportResponse,
  TrustedAuthorityResolver,
  WriteIntent,
} from "./provider-contracts";

export class StorageAdapterError extends Error {}
function fail(reason: string): never {
  throw new StorageAdapterError(reason);
}
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const identifier = z.string().min(1).max(1024);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const intentSchema = z
  .object({
    ownerId: identifier,
    sessionId: identifier,
    fileId: identifier,
    attemptId: identifier,
    requestId: identifier,
    resourceId: identifier,
    executorId: identifier,
    bucket: identifier,
    path: identifier,
    epoch: count.min(1),
    dispatchGeneration: count.min(1),
    declaredBytes: count,
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    operation: z.literal("single-object-create"),
  })
  .strict();
export const permitSchema = z
  .object({
    intent: intentSchema,
    decisionId: identifier,
    writerId: identifier,
    reservationId: identifier,
    exposureId: identifier,
    maximumEncodedBytes: count,
    reservedExposureBytes: count,
    allowZeroBytes: z.boolean(),
  })
  .strict();
const responseSchema = z
  .object({
    kind: z.literal("response"),
    provenance: z.literal("authenticated-storage-response"),
    status: z.number().int().min(100).max(599),
    requestId: identifier.nullable(),
    version: identifier.nullable(),
    etag: identifier.nullable(),
    acknowledgedBytes: count.nullable(),
  })
  .strict();

/** Local candidate only: injected transport, no credential or route wiring.
 * Intentionally incompatible with core's size-only commit/cleanup interface.
 */
export class SupabaseStorageProvider {
  constructor(
    private readonly transport: StorageTransport,
    private readonly authority: TrustedAuthorityResolver,
    private readonly evidence: DurableEvidenceSink,
    private readonly limits = { timeoutMs: 30_000, maximumChunkBytes: 65_536 },
    private readonly now: () => number = Date.now,
  ) {
    this.limits = Object.freeze({ ...limits });
    if (
      !integer(limits.timeoutMs) ||
      limits.timeoutMs < 1 ||
      limits.timeoutMs > 2_147_483_647 ||
      !integer(limits.maximumChunkBytes) ||
      limits.maximumChunkBytes < 1 ||
      limits.maximumChunkBytes > 65_536
    )
      fail("INVALID_LIMITS");
  }

  async write(rawIntent: WriteIntent, source: AsyncIterable<Uint8Array>) {
    const intent = Object.freeze({ ...rawIntent });
    if (intent.operation !== "single-object-create")
      fail("UNSUPPORTED_CAPABILITY");
    if (!intentSchema.safeParse(intent).success) fail("INVALID_INTENT");
    this.transport.assertSupported(intent.operation);
    if (
      !integer(intent.declaredBytes) ||
      !/^[a-f0-9]{64}$/.test(intent.expectedSha256) ||
      !integer(intent.epoch) ||
      intent.epoch < 1 ||
      !integer(intent.dispatchGeneration) ||
      intent.dispatchGeneration < 1 ||
      [
        intent.ownerId,
        intent.sessionId,
        intent.fileId,
        intent.attemptId,
        intent.requestId,
        intent.resourceId,
        intent.executorId,
        intent.bucket,
        intent.path,
      ].some((v) => typeof v !== "string" || !v.length)
    )
      fail("INVALID_INTENT");
    const resolved = permitSchema.safeParse(
      await this.authority.consumeDispatch(intent),
    );
    if (!resolved.success) return fail("INVALID_GRANT");
    const permit = Object.freeze(resolved.data);
    if (
      !permit ||
      Object.keys(intent).some(
        (key) =>
          intent[key as keyof WriteIntent] !==
          permit.intent[key as keyof WriteIntent],
      ) ||
      !permit.decisionId ||
      !permit.writerId ||
      !permit.reservationId ||
      !permit.exposureId ||
      !integer(permit.maximumEncodedBytes) ||
      !integer(permit.reservedExposureBytes) ||
      intent.declaredBytes > permit.maximumEncodedBytes ||
      permit.reservedExposureBytes < permit.maximumEncodedBytes ||
      (intent.declaredBytes === 0 && permit.allowZeroBytes !== true)
    )
      fail("INVALID_GRANT");

    const controller = new AbortController();
    const hash = createHash("sha256");
    let inputBytes = 0,
      forwardedBytes = 0,
      complete = false;
    let digest: string | null = null,
      streamError: string | null = null;
    let response: TransportResponse | null = null;
    let state: ProvisionalObservation["state"] = "dispatch-intent";
    let reason = "DISPATCH_INTENT";
    const startedAt = this.now();
    const observation = (): ProvisionalObservation =>
      Object.freeze({
        classification: "provisional",
        intent,
        decisionId: permit.decisionId,
        writerId: permit.writerId,
        reservationId: permit.reservationId,
        exposureId: permit.exposureId,
        maximumEncodedBytes: permit.maximumEncodedBytes,
        reservedExposureBytes: permit.reservedExposureBytes,
        startedAt,
        finishedAt: this.now(),
        state,
        reason,
        inputBytes,
        forwardedBytes,
        sha256:
          state === "dispatch-intent"
            ? null
            : (digest ?? hash.copy().digest("hex")),
        digestComplete: complete,
        response,
        evidencePersistence: "pending-durable-ack",
        futureProviderEffectsPossible: true,
        retainHolds: true,
        certified: false,
      });
    // Lost evidence acknowledgment leaves the consumed durable grant occupied.
    try {
      const ack = await this.evidence.append(observation());
      if (!ack.receiptId) fail("EVIDENCE_FAILURE");
    } catch {
      fail("EVIDENCE_FAILURE");
    }
    const maximumChunkBytes = this.limits.maximumChunkBytes;
    const body = (async function* () {
      try {
        for await (const chunk of source) {
          if (controller.signal.aborted) fail("ABORTED");
          if (!(chunk instanceof Uint8Array)) fail("INVALID_CHUNK");
          inputBytes += chunk.byteLength;
          if (
            !integer(inputBytes) ||
            inputBytes > intent.declaredBytes ||
            inputBytes > permit.maximumEncodedBytes
          )
            fail("OVERSIZED");
          if (chunk.byteLength > maximumChunkBytes) fail("CHUNK_TOO_LARGE");
          // One bounded copy prevents producer mutation while transport consumes it.
          const copy = Uint8Array.from(chunk);
          hash.update(copy);
          forwardedBytes += copy.byteLength;
          yield copy;
        }
        if (controller.signal.aborted) fail("ABORTED");
        if (inputBytes !== intent.declaredBytes) fail("TRUNCATED");
        digest = hash.digest("hex");
        complete = true;
        if (digest !== intent.expectedSha256) fail("HASH_MISMATCH");
      } catch (error) {
        streamError =
          error instanceof StorageAdapterError
            ? error.message
            : "INPUT_FAILURE";
        controller.abort();
        throw error;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StorageAdapterError("TIMEOUT"));
        }, this.limits.timeoutMs);
      });
      const rawResponse = await Promise.race([
        this.transport.create({
          permit,
          intent,
          body,
          signal: controller.signal,
          options: {
            redirect: "error",
            retries: 0,
            upsert: false,
            contentType: "application/octet-stream",
            contentLength: intent.declaredBytes,
          },
        }),
        timeout,
      ]);
      const parsedResponse = responseSchema.safeParse(rawResponse);
      if (!parsedResponse.success) fail("UNVERIFIED_RESPONSE");
      response = Object.freeze(parsedResponse.data);
      if (streamError) fail(streamError);
      if (!complete) fail("INPUT_NOT_EXHAUSTED");
      if (
        response.kind !== "response" ||
        response.provenance !== "authenticated-storage-response" ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300 ||
        response.acknowledgedBytes !== intent.declaredBytes
      )
        fail("UNVERIFIED_RESPONSE");
      response = Object.freeze({ ...response });
      state = "response-observed";
      reason = "EXACT_STREAM_RESPONSE_OBSERVED";
    } catch (error) {
      state = "ambiguous";
      reason =
        streamError ??
        (error instanceof StorageAdapterError
          ? error.message
          : "TRANSPORT_FAILURE");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
    const result = observation();
    try {
      const ack = await this.evidence.append(result);
      if (!ack.receiptId) fail("EVIDENCE_FAILURE");
      return {
        observation: result,
        evidencePersistence: "durable-acknowledged" as const,
        receiptId: ack.receiptId,
      };
    } catch {
      return {
        observation: result,
        evidencePersistence: "failed-or-unknown" as const,
        receiptId: null,
      };
    }
  }
}
