import { z } from "zod";
import { request } from "node:https";
import {
  postgresAttemptClaims,
  postgresClaimQualification,
} from "./disposable-postgres-claims";
import {
  executeDisposableRoundTrip,
  disposableSupabaseAdapter,
} from "./disposable-roundtrip-executor";
import { ordinarySessionBridge } from "./disposable-ordinary-session";
import { runOperatorRoundTrip } from "./disposable-roundtrip-host";
import {
  preflightDisposableUpload,
  disposableUploadTarget as target,
} from "./disposable-upload-contract";

const reference = z.string().trim().min(1).max(256);
// Explicit null means unrestricted. Missing, empty or malformed values fail closed.
const allowedMimeTypes = z.array(z.string()).min(1).nullable();
const canonicalMimeTypes = (value: string[] | null) =>
  JSON.stringify(value === null ? null : [...value].sort());
const evidenceSchema = z
  .object({
    config: z.unknown(),
    qualification: z.union([
      postgresClaimQualification,
      z
        .object({
          claimDirectory: z.literal("C:\\SmartStorage-Upload-Claims"),
          retentionAndPowerLossReview: reference,
          effectivePermissionsReview: reference,
          ordinarySessionVerificationReview: reference,
        })
        .strict(),
    ]),
    bucket: z
      .object({
        id: z.literal(target.bucket),
        name: z.literal(target.bucket),
        public: z.literal(false),
        file_size_limit: z.number().int().min(89),
        allowed_mime_types: allowedMimeTypes,
      })
      .strict(),
    absence: z
      .object({
        project: z.literal(target.project),
        bucket: z.literal(target.bucket),
        key: z.literal(target.key),
        exists: z.literal(false),
        checkedAt: z.number().int(),
        authoritativeReview: reference,
      })
      .strict(),
    providerCompatibilityReview: reference,
    expiresAt: z.number().int(),
  })
  .strict();

/** Reviews are external evidence assertions. Ordinary RLS-filtered empty lists
 * alone NEVER establish absence or INSERT permission. No receipts are persisted. */
export async function launchDisposableRoundTrip(input: {
  mode: "--preflight" | "--execute";
  evidence: unknown;
  source: Uint8Array<ArrayBuffer>;
  encoded: Uint8Array<ArrayBuffer>;
  hidden: (prompt: string) => Promise<string>;
  transport: typeof fetch;
  now?: () => number;
}) {
  if (input.mode !== "--preflight" && input.mode !== "--execute")
    throw Error("INVALID_MODE");
  const now = input.now ?? Date.now;
  const e = evidenceSchema.parse(input.evidence);
  const config = await preflightDisposableUpload(
    e.config,
    input.source,
    input.encoded,
  );
  const fresh = () => {
    if (
      e.expiresAt <= now() ||
      e.expiresAt > now() + 600_000 ||
      e.absence.checkedAt > now() ||
      now() - e.absence.checkedAt > 120_000
    )
      throw Error("CURRENT_EVIDENCE_REQUIRED");
  };
  fresh();
  if (
    e.qualification.effectivePermissionsReview !==
      config.createReadPermissionReviewReference ||
    e.bucket.file_size_limit < input.encoded.length ||
    (e.bucket.allowed_mime_types !== null &&
      !e.bucket.allowed_mime_types.includes("application/octet-stream"))
  )
    throw Error("UNQUALIFIED_REVIEW");
  if (
    (await input.hidden(
      "Authorize ONE login, ONE Auth identity check and TWO read-only Storage metadata requests. Type PREFLIGHT DISPOSABLE (hidden): ",
    )) !== "PREFLIGHT DISPOSABLE"
  )
    throw Error("PREFLIGHT_CONFIRMATION_REQUIRED");
  const publicKey = await input.hidden(
    "Disposable public publishable/anon key (hidden): ",
  );
  const session = await ordinarySessionBridge({
    publicUrl: "https://rrylhvqalsxjnkdkpwde.supabase.co",
    publicKey,
    credentials: async () => ({
      email: await input.hidden("Dedicated email (hidden): "),
      password: await input.hidden("Dedicated password (hidden): "),
    }),
    transport: input.transport,
    now,
  })();
  const check = () => {
    fresh();
    if (session.expiresAt <= now()) throw Error("SESSION_EXPIRED");
  };
  const metadata = async (path: string, body?: string) => {
    check();
    const response = await input.transport(`${target.endpoint}/${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
      },
      ...(body ? { body } : {}),
    });
    if (
      response.status !== 200 ||
      (response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity")
    )
      throw Error("STORAGE_PREFLIGHT_UNCERTAIN");
    const reader = response.body?.getReader();
    if (!reader) throw Error("STORAGE_PREFLIGHT_UNCERTAIN");
    let text = "",
      size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw Error("STORAGE_PREFLIGHT_LIMIT");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } finally {
      await reader.cancel();
    }
  };
  const bucket = z
    .object({
      id: z.string(),
      name: z.string(),
      public: z.boolean(),
      file_size_limit: z.number(),
      allowed_mime_types: allowedMimeTypes,
    })
    .parse(await metadata(`bucket/${target.bucket}`));
  if (
    bucket.id !== e.bucket.id ||
    bucket.name !== e.bucket.name ||
    bucket.public !== false ||
    bucket.file_size_limit !== e.bucket.file_size_limit ||
    canonicalMimeTypes(bucket.allowed_mime_types) !==
      canonicalMimeTypes(e.bucket.allowed_mime_types)
  )
    throw Error("UNEXPECTED_BUCKET_CONFIGURATION");
  const entries = await metadata(
    `object/list/${target.bucket}`,
    JSON.stringify({
      prefix: "practice-roundtrip/20261019",
      search: "compressed-test-001.bin",
      limit: 2,
      offset: 0,
    }),
  );
  if (!Array.isArray(entries) || entries.length !== 0)
    throw Error("KEY_PRESENT_OR_AMBIGUOUS");
  check();
  if (input.mode === "--preflight") return { preflight: true as const };
  // A live invocation always runs a fresh preflight in this process/session.
  // No file or previous command can act as a reusable success receipt.
  if (
    (await input.hidden(
      "Preflight passed. Authorize ONE create-only upload and ONE verification download of practice-roundtrip/20261019/compressed-test-001.bin. Type UPLOAD DISPOSABLE ONCE (hidden): ",
    )) !== "UPLOAD DISPOSABLE ONCE"
  )
    throw Error("LIVE_CONFIRMATION_REQUIRED");
  check();
  const execution = {
    config,
    source: input.source,
    encoded: input.encoded,
    qualification: e.qualification,
    authorization: {
      project: target.project,
      bucket: target.bucket,
      key: target.key,
      upload: 1,
      download: 1,
      expiresAt: Math.min(
        e.expiresAt,
        now() + 120_000,
        e.absence.checkedAt + 120_000,
      ),
    },
    verifiedSession: async () => {
      check();
      return session;
    },
  };
  if ("claimRegistry" in e.qualification) {
    // PostgreSQL replaces only the Windows fence. All other gates above and
    // the existing bounded executor/transport remain mandatory.
    return executeDisposableRoundTrip({
      ...execution,
      session: execution.verifiedSession,
      claimOnce: postgresAttemptClaims({
        session,
        publicKey,
        transport: input.transport,
        check,
      }),
      provider: disposableSupabaseAdapter(request),
      now,
    });
  }
  return runOperatorRoundTrip(execution);
}
