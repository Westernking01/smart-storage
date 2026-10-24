import { z } from "zod";
import { digest } from "../../src/lib/transfers/codec";
import { HASH, type Block } from "../../src/lib/transfers/format";

export const disposableUploadTarget = Object.freeze({
  project: "rrylhvqalsxjnkdkpwde",
  endpoint: "https://rrylhvqalsxjnkdkpwde.supabase.co/storage/v1",
  userId: "310d0ec8-84ca-423a-b646-0480a20edc09",
  bucket: "smart-storage-gateway-probe",
  key: "practice-roundtrip/20261019/compressed-test-001.bin",
});
export const MAX_TEST_BYTES = 65_536;
const bytes = z.number().int().min(1).max(MAX_TEST_BYTES);
const reference = z.string().trim().min(1).max(256);
export const disposableUploadConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    project: z.literal(disposableUploadTarget.project),
    endpoint: z.literal(disposableUploadTarget.endpoint),
    userId: z.literal(disposableUploadTarget.userId),
    bucket: z.literal(disposableUploadTarget.bucket),
    key: z.literal(disposableUploadTarget.key),
    privateBucket: z.literal(true),
    codec: z.literal("gzip"),
    sourceBytes: bytes,
    encodedBytes: bytes,
    sourceSha256: z.string().regex(HASH),
    encodedSha256: z.string().regex(HASH),
    fixtureVerificationReference: reference,
    createReadPermissionReviewReference: reference,
    credentialSource: z.literal("external-verified-ordinary-session"),
    applicationEnvironmentFallback: z.literal(false),
    upsert: z.literal(false),
    overwrite: z.literal(false),
    retries: z.literal(0),
    redirects: z.literal(0),
    delete: z.literal(false),
    operations: z
      .object({ upload: z.literal(1), download: z.literal(1) })
      .strict(),
    maximumUploadBytes: z.literal(MAX_TEST_BYTES),
    maximumDownloadBytes: z.literal(MAX_TEST_BYTES),
    timeoutMs: z.literal(30_000),
  })
  .strict();

/** Offline only: validates independently prepared bytes using existing hashes.
 * No credential acquisition, provider transport, route or gateway composition. */
export async function preflightDisposableUpload(
  candidate: unknown,
  source: Uint8Array<ArrayBuffer>,
  encoded: Uint8Array<ArrayBuffer>,
) {
  const c = disposableUploadConfigSchema.parse(candidate);
  if (!c.enabled) throw Error("DISPOSABLE_UPLOAD_DISABLED");
  if (
    source.byteLength !== c.sourceBytes ||
    encoded.byteLength !== c.encodedBytes ||
    digest(source) !== c.sourceSha256 ||
    digest(encoded) !== c.encodedSha256
  )
    throw Error("DISPOSABLE_UPLOAD_INTEGRITY");
  // Existing restore validates encoded hash, bounded gzip decode, original hash
  // and whole-file hash. No file system or transfer-store activation is needed.
  const { restore } = await import("../../src/lib/transfers/restore");
  const block: Block = {
    index: 0,
    offset: 0,
    codec: c.codec,
    originalBytes: c.sourceBytes,
    originalSha256: c.sourceSha256,
    encodedBytes: c.encodedBytes,
    encodedSha256: c.encodedSha256,
  };
  await restore(
    {
      format: "compression-spike",
      version: 1,
      blockSize: MAX_TEST_BYTES,
      originalBytes: c.sourceBytes,
      originalSha256: c.sourceSha256,
      blocks: [block],
    },
    {
      async open() {
        return {
          index: 0,
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(encoded.slice());
              controller.close();
            },
          }),
        };
      },
    },
    { async write() {}, async commit() {}, async abort() {} },
  );
  return Object.freeze({ ...c, operations: Object.freeze(c.operations) });
}

/** Host must implement atomic durable claims, retained even after ambiguity.
 * Claims bind to the immutable object, never an approval ID that can be renewed.
 * This helper issues no requests and cannot certify remote absence/permissions. */
export function disposableUploadAttemptGate(
  claimOnce: (key: string) => Promise<boolean>,
) {
  const attempted = new Set<string>();
  return async (operation: "upload" | "download") => {
    if (operation !== "upload" && operation !== "download")
      throw Error("DISPOSABLE_UPLOAD_OPERATION");
    if (attempted.has(operation)) throw Error("DISPOSABLE_UPLOAD_ATTEMPT_USED");
    attempted.add(operation); // also consume on a failed/ambiguous durable claim
    const t = disposableUploadTarget;
    if (!(await claimOnce(`${t.project}/${t.bucket}/${t.key}/${operation}`)))
      throw Error("DISPOSABLE_UPLOAD_ATTEMPT_USED");
  };
}
