import { Ledger } from "./ledger.js";
import { renewalBytes, validateSessionProgress } from "./renewal-evidence.js";
import { PROJECT, BUCKET, RUN, MANIFEST_HASH } from "./manifest.js";

// Read-only projection: never returns tokens, approval IDs, digests or URLs.
export function renewalDiagnostic(ledger: Ledger) {
  const history = ledger.approvalHistory();
  const events = ledger.state.renewalEvents ?? [];
  const first = events[0];
  if (first) {
    const base = history.rows[first.approval.generation]?.state;
    if (!base) throw new Error("SESSION_RENEWAL_CHECKPOINT_INVALID");
    let prior = base;
    for (const row of history.rows.slice(first.approval.generation)) {
      validateSessionProgress(base, prior, row.state);
      for (const e of row.state.renewalEvents ?? []) {
        const anchor = history.rows[e.approval.generation];
        if (
          !anchor ||
          e.approval.ledgerIdentity !== history.identity ||
          anchor.digest !== e.approval.digest ||
          e.approval.generation >= row.generation
        )
          throw new Error("SESSION_RENEWAL_CHECKPOINT_INVALID");
      }
      prior = row.state;
    }
  }
  const requests = events.map((e, index) => {
    const transitions: {
      generation: number;
      state: string;
      status: number | null;
    }[] = [];
    for (const row of history.rows) {
      const current = row.state.renewalEvents?.[index];
      if (current && transitions.at(-1)?.state !== current.state)
        transitions.push({
          generation: row.generation,
          state: current.state,
          status: current.status ?? null,
        });
    }
    const dispatched = transitions.some((x) => x.state === "dispatched");
    return {
      index: index + 1,
      round: e.approval.round ?? 1,
      actor: e.actor,
      operation: e.operation,
      reservedAt: e.at,
      attemptedBodyBytes: e.bytes,
      state: e.state,
      status: e.status ?? null,
      dispatchMarkerObserved: dispatched,
      durableCompletedResponse: e.state === "completed",
      durableIdentityVerification:
        e.state === "completed" && e.operation === "identity" && !!e.identity,
      evidence:
        e.state === "completed"
          ? "RESPONSE_COMMITTED"
          : e.state === "failed"
            ? "FAILED_RESPONSE_OR_LOCAL_COMMIT_FAILURE"
            : dispatched
              ? "DISPATCH_MARKER_WITHOUT_COMMITTED_RESPONSE"
              : "RESERVATION_WITHOUT_DISPATCH_MARKER",
      transitions,
    };
  });
  return {
    project: PROJECT,
    bucket: BUCKET,
    run: RUN,
    manifestHash: MANIFEST_HASH,
    encryptedJournalAndSnapshotVerified: true,
    sessionHistoryVerified: true,
    requests,
    originalStageCount: ledger.state.entries.slice(0, 7).length,
    storageContinuationRequests: Math.max(0, ledger.state.entries.length - 7),
    attemptedAllocations: ledger.state.allocations,
    stageBodyBytes: ledger.state.bytes,
    attemptedRenewalBodyBytes: renewalBytes(ledger.state),
    totalAttemptedBodyBytes: ledger.state.bytes + renewalBytes(ledger.state),
    renewalExecutionBlocked:
      events.some((e) => e.state !== "completed") || events.length > 4,
    storageExecutionBlockedByRenewal:
      ![4, 8].includes(events.length) ||
      events.some((e) => e.state !== "completed"),
    recoveryAuthorized: false,
    providerRequests: 0,
    cleanupExecuted: false,
    limitation:
      "Dispatch marker precedes fetch; it does not prove wire delivery. No durable response-received marker exists. Never replay dispatched or ambiguous requests.",
    adr041: "UNRESOLVED",
  };
}
