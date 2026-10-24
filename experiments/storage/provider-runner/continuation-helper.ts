import { randomBytes } from "node:crypto";
import { Ledger } from "./ledger.js";
import {
  PROJECT,
  BUCKET,
  RUN,
  MANIFEST_HASH,
  STAGES,
  approve,
  type Approval,
} from "./manifest.js";
import { continuationCheckpoint, assertContinuation } from "./continuation.js";
import { renewalBytes } from "./renewal-evidence.js";
import { usableSession, sessionLifetime } from "./session.js";
import { summary } from "./runner.js";
import { runCli, type PrivateExecution } from "./cli.js";
export async function invokePrivateContinuation(
  context: PrivateExecution,
  invoke: typeof runCli = runCli,
): Promise<void> {
  context.check();
  approve(context.permission, context.confirmation);
  assertContinuation(context.ledger, context.permission);
  await invoke(["--execute"], context);
}

export const CONTINUATION_PROMPT = `Target ${PROJECT} / ${BUCKET} / ${RUN}. Execute exactly 10 remaining Storage stages; additional limits 2 allocations / 6,292,512 stage-body bytes; no Auth, retry or cleanup. Type EXECUTE TEN STORAGE STAGES to authorize: `;
export function continuationCandidate(ledger: Ledger): Approval {
  const continuation = continuationCheckpoint(ledger);
  const events = ledger.state.renewalEvents;
  if (
    !events ||
    ![4, 8].includes(events.length) ||
    events.some((e) => e.state !== "completed")
  )
    throw new Error("VERIFIED_SESSION_RENEWAL_REQUIRED");
  for (const actor of ["A", "B"] as const) {
    const s = ledger.state.sessions[actor];
    if (!s?.verified || !usableSession(s.token, actor, Date.now(), 1800000))
      throw new Error("CONTINUATION_SESSION_LIFETIME_INSUFFICIENT");
  }
  if (ledger.state.bytes + renewalBytes(ledger.state) + 6292512 > 6325536)
    throw new Error("FIRST_WAVE_BUDGET_EXHAUSTED");
  const now = Date.now();
  const permission: Approval = {
    schemaVersion: 2,
    kind: "storage-provider-execution",
    id: randomBytes(32).toString("hex"),
    project: PROJECT,
    bucket: BUCKET,
    run: RUN,
    manifestHash: MANIFEST_HASH,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1800000).toISOString(),
    purposes: [...new Set(STAGES.slice(7).map((s) => s.purpose))],
    acknowledgedRuntimeUncertainties: true,
    continuation,
  };
  approve(permission, permission.id);
  assertContinuation(ledger, permission);
  return permission;
}
export async function confirmContinuation(
  ledger: Ledger,
  question: (prompt: string) => Promise<string>,
  create: (permission: Approval) => string,
  check: () => void,
): Promise<{ permission: Approval; file: string }> {
  check();
  continuationCandidate(ledger);
  if ((await question(CONTINUATION_PROMPT)) !== "EXECUTE TEN STORAGE STAGES")
    throw new Error("CONTINUATION_NOT_CONFIRMED");
  check();
  const permission = continuationCandidate(ledger);
  const file = create(permission);
  approve(permission, permission.id);
  assertContinuation(ledger, permission);
  return { permission, file };
}
export function continuationResult(ledger: Ledger, error?: string) {
  const entries = ledger.state.entries.slice(7);
  const completed =
    entries.length === 10 &&
    entries.every((e) => e.state === "completed") &&
    !ledger.isHalted() &&
    !error;
  const resources = Object.values(ledger.state.resources);
  const ownershipVerified = ledger.cleanupPreview().length === 2;
  const tusComplete =
    resources.length === 1 &&
    resources[0].complete &&
    resources[0].offset === 6292480;
  return {
    ...summary(ledger),
    sessionLifetime: Object.fromEntries(
      (["A", "B"] as const).map((actor) => [
        actor,
        sessionLifetime(ledger.state.sessions[actor]?.token ?? ""),
      ]),
    ),
    classification:
      completed && tusComplete && ownershipVerified
        ? "FIRST WAVE PASSED"
        : error === "UNEXPECTED_SUCCESS_FOR_DENIAL" ||
            error === "OWNER_METADATA_MISMATCH" ||
            error === "OFFSET_MISMATCH"
          ? "FIRST WAVE FAILED"
          : "FIRST WAVE STOPPED / INCOMPLETE",
    stopCode:
      error ?? (ownershipVerified ? null : "OWNER_VERIFICATION_PENDING"),
    storageContinuationRequests: entries.length,
    additionalAllocations: ledger.state.allocations - 1,
    additionalStageBodyBytes: ledger.state.bytes - 474,
    tusOffsets: entries
      .filter((e) => e.purpose === "tus-head" || e.purpose === "tus-part")
      .map((e) => ({
        stage: e.id,
        status: e.status ?? null,
        offset: e.offset ?? null,
      })),
    tusComplete,
    ownershipVerified,
    incompleteTusResources: resources.filter((r) => !r.complete).length,
    previouslyVerifiedA00Objects: 1,
    completedTusObjects: Number(tusComplete),
    possibleUnauthorizedWrite: entries.some(
      (e) =>
        e.id === "wrong-owner-B" &&
        e.status !== undefined &&
        e.status >= 200 &&
        e.status < 300,
    ),
    remoteInventoryIndependentlyVerified: false,
    cleanupExecuted: false,
    adr041: "UNRESOLVED",
  };
}
