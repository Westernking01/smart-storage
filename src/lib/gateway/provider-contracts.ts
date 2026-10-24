import "server-only";
import type { GatewayWriteAuthorization } from "./core";

export type WriteIntent = GatewayWriteAuthorization &
  Readonly<{
    sessionId: string;
    fileId: string;
    attemptId: string;
    declaredBytes: number;
    expectedSha256: string;
    operation: "single-object-create";
  }>;

export type DispatchPermit = Readonly<{
  intent: WriteIntent;
  decisionId: string;
  writerId: string;
  reservationId: string;
  exposureId: string;
  maximumEncodedBytes: number;
  reservedExposureBytes: number;
  allowZeroBytes: boolean;
}>;

/** Trusted server implementation must authenticate caller independently, lock and
 * resolve immutable membership/current epoch, reserve bounded total physical
 * exposure, enforce one active writer, and consume a fresh dispatch exactly once.
 * Replays (including lost DB acknowledgments) must deny. A no-write recovery may
 * issue fresh authority only via a separate durable recovery protocol.
 * No process-local map/boolean can implement this contract in production.
 */
export interface TrustedAuthorityResolver {
  consumeDispatch(intent: WriteIntent): Promise<DispatchPermit | null>;
}

export type TransportResponse = Readonly<{
  kind: "response";
  status: number;
  provenance: "authenticated-storage-response";
  requestId: string | null;
  version: string | null;
  etag: string | null;
  acknowledgedBytes: number | null;
}>;

/** No SDK defaults: implementations must reject unsupported operation/options,
 * send exactly one standard create request, and never retry/follow redirects,
 * replace, upsert, copy, or create multipart/TUS resources. Unknown physical
 * exposure must be rejected by authority before this interface is invoked.
 */
export interface StorageTransport {
  assertSupported(operation: string): void;
  create(input: {
    permit: DispatchPermit;
    intent: WriteIntent;
    body: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
    options: Readonly<{
      redirect: "error";
      retries: 0;
      upsert: false;
      contentType: "application/octet-stream";
      contentLength: number;
    }>;
  }): Promise<TransportResponse>;
}

export type ProvisionalObservation = Readonly<{
  classification: "provisional";
  intent: WriteIntent;
  decisionId: string;
  writerId: string;
  reservationId: string;
  exposureId: string;
  startedAt: number;
  maximumEncodedBytes: number;
  reservedExposureBytes: number;
  finishedAt: number;
  state: "dispatch-intent" | "response-observed" | "ambiguous";
  reason: string;
  inputBytes: number;
  forwardedBytes: number;
  sha256: string | null;
  digestComplete: boolean;
  response: TransportResponse | null;
  evidencePersistence: "pending-durable-ack";
  futureProviderEffectsPossible: true;
  retainHolds: true;
  certified: false;
}>;

/** Append-only trusted durable store. Resolve only after commit; reject on lost
 * acknowledgment. Bind operation/scope and make identical evidence idempotent.
 * Returned IDs are persistence receipts, never provider certificates.
 */
export interface DurableEvidenceSink {
  append(observation: ProvisionalObservation): Promise<{ receiptId: string }>;
}

export type ProviderObservationHint = Readonly<{
  visibility: "present" | "absent" | "unknown";
  discovery: "complete" | "incomplete" | "unknown";
}>;

/** Hints (including 404/masked absence) cannot close writers or settle storage. */
export function retainProviderHolds(_hint: ProviderObservationHint) {
  void _hint;
  return { retainHolds: true, certified: false } as const;
}
