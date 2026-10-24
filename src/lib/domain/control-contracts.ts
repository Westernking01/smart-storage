import { parseFileMetadata, type FileMetadata } from "./file-metadata";
/** Phase 2 control-plane contracts; no SDK, authority minting or network calls. */
export type FileState =
  "uploading" | "ready" | "failed" | "deleting" | "deleted";
export type SessionState =
  | "reserved"
  | "uploading"
  | "reconciling"
  | "finalizing"
  | "completed"
  | "cancelling"
  | "expired"
  | "settled";
export type DecimalBytes = string & { readonly __decimalBytes: unique symbol };
const MAX_BIGINT = BigInt("9223372036854775807");
export function parseDecimalBytes(value: unknown): DecimalBytes {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > MAX_BIGINT
  )
    throw Error("BYTE_COUNT_INVALID");
  return value as DecimalBytes;
}
export interface CreateSessionInput {
  idempotencyKey: string;
  metadata: FileMetadata;
  originalBytes: DecimalBytes;
  sourceSha256: string;
  format: "compression-spike";
  version: 1;
}
export function parseCreateSession(value: unknown): CreateSessionInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("SESSION_INPUT_INVALID");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "idempotencyKey",
          "metadata",
          "originalBytes",
          "sourceSha256",
          "format",
          "version",
        ].includes(key),
    ) ||
    typeof v.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9_-]{16,80}$/.test(v.idempotencyKey) ||
    typeof v.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.sourceSha256) ||
    v.format !== "compression-spike" ||
    v.version !== 1
  )
    throw Error("SESSION_INPUT_INVALID");
  const originalBytes = parseDecimalBytes(v.originalBytes);
  // Keep the actual implemented envelope; this is not the proposed 1 GiB cap.
  if (BigInt(originalBytes) > BigInt("33554432"))
    throw Error("LOCAL_FILE_LIMIT");
  return {
    idempotencyKey: v.idempotencyKey,
    metadata: parseFileMetadata(v.metadata),
    originalBytes,
    sourceSha256: v.sourceSha256,
    format: v.format,
    version: v.version,
  };
}
export interface OwnedFileSummary {
  id: string;
  metadata: FileMetadata;
  displayName: string;
  state: FileState;
  originalBytes: DecimalBytes;
  storedBytes: DecimalBytes | null;
}
/** Provider length is not cryptographic proof. Future adapters must distinguish them. */
export interface ObjectObservation {
  attemptId: string;
  observedBytes: DecimalBytes;
  ownershipVerified: boolean;
  digest:
    { kind: "unavailable" } | { kind: "trusted-byte-reader"; sha256: string };
}
export interface UsageSummary {
  quotaBytes: DecimalBytes;
  storedBytes: DecimalBytes;
  reservedBytes: DecimalBytes;
  activeSlots: number;
}
