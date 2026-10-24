import { z } from "zod";
import { disposableUploadTarget as target } from "./disposable-upload-contract";
import type { VerifiedDisposableSession } from "./disposable-roundtrip-executor";

const reference = z.string().trim().min(1).max(256);
export const postgresClaimQualification = z
  .object({
    claimRegistry: z.literal("postgresql-v1"),
    project: z.literal(target.project),
    deploymentReview: reference,
    committedResponseReview: reference,
    retentionAndPowerLossReview: reference,
    privilegedRollbackAndRestoreReview: reference,
    effectivePermissionsReview: reference,
    ordinarySessionVerificationReview: reference,
  })
  .strict();

/** Requires externally qualified commit-before-response and retention controls.
 * No credentials from disk/env; no retry or response-body logging. */
export function postgresAttemptClaims(input: {
  session: VerifiedDisposableSession;
  publicKey: string;
  transport: typeof fetch;
  check: () => void;
}) {
  const attempted = new Set<string>();
  return async (key: string): Promise<boolean> => {
    const prefix = `${target.project}/${target.bucket}/${target.key}/`;
    const operation = key.slice(prefix.length);
    if (!key.startsWith(prefix) || !["upload", "download"].includes(operation))
      throw Error("CLAIM_TARGET_DENIED");
    if (attempted.has(operation)) throw Error("CLAIM_ATTEMPT_USED");
    attempted.add(operation); // includes dispatch errors and ambiguous responses
    input.check();
    const response = await input.transport(
      `https://${target.project}.supabase.co/rest/v1/rpc/smart_storage_claim_once`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${input.session.accessToken}`,
          apikey: input.publicKey,
          "Content-Type": "application/json",
          "Accept-Encoding": "identity",
          Prefer: "tx=commit",
        },
        body: JSON.stringify({ p_operation: operation }),
      },
    );
    if (
      response.status !== 200 ||
      (response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity") ||
      /tx=rollback/i.test(response.headers.get("preference-applied") ?? "")
    ) {
      await response.body?.cancel();
      throw Error("CLAIM_UNCERTAIN_STOP");
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("CLAIM_UNCERTAIN_STOP");
    const bytes: number[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes.length + value.length > 16)
          throw Error("CLAIM_UNCERTAIN_STOP");
        bytes.push(...value);
      }
    } finally {
      await reader.cancel();
    }
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(new Uint8Array(bytes))
      .trim();
    input.check();
    if (text === "false") return false;
    if (text !== "true") throw Error("CLAIM_UNCERTAIN_STOP");
    return true;
  };
}
