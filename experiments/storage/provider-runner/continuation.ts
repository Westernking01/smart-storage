import {
  STAGES,
  USERS,
  approve,
  validateIntent,
  type Approval,
  type Intent,
} from "./manifest.js";
import { Ledger, type Entry } from "./ledger.js";
import { validateSessionProgress, renewalBytes } from "./renewal-evidence.js";
import { usableSession } from "./session.js";

// Returns binding data only; does not create an approval or mutate the ledger.
export function continuationCheckpoint(
  ledger: Ledger,
): NonNullable<Approval["continuation"]> {
  const history = ledger.approvalHistory();
  const current = history.rows.at(-1)!;
  if (
    ledger.isHalted() ||
    ledger.state.entries.length !== 7 ||
    !ledger.isReconciled("cross-read-B") ||
    ledger.state.allocations !== 1 ||
    ledger.state.bytes !== 474 ||
    Object.keys(ledger.state.resources).length ||
    JSON.stringify(ledger.continuationPlan().stages) !==
      JSON.stringify(STAGES.slice(7).map((s) => s.id))
  )
    throw new Error("CONTINUATION_CHECKPOINT_INVALID");
  return {
    ledgerIdentity: history.identity,
    generation: current.generation,
    digest: current.digest,
    stages: STAGES.slice(7).map((s) => s.id),
    initialAllocations: 1,
    initialBytes: 474,
    maxAdditionalAllocations: 2,
    maxAdditionalBytes: 6292512,
  };
}

export function assertContinuation(
  ledger: Ledger,
  permission: Approval,
  intent?: Intent,
  reserved = false,
): void {
  // Old approvals remain usable for original runs, never for a reconciled continuation.
  if (permission.schemaVersion !== 2) {
    if (ledger.isReconciled("cross-read-B"))
      throw new Error("CONTINUATION_APPROVAL_REQUIRED");
    return;
  }
  approve(permission, permission.id);
  const c = permission.continuation!;
  const history = ledger.approvalHistory();
  const checkpoint = history.rows[c.generation];
  if (
    history.identity !== c.ledgerIdentity ||
    !checkpoint ||
    checkpoint.digest !== c.digest ||
    checkpoint.state.entries.length !== 7 ||
    checkpoint.state.allocations !== 1 ||
    checkpoint.state.bytes !== 474 ||
    !checkpoint.state.reconciliations?.length ||
    ledger.isHalted()
  )
    throw new Error("CONTINUATION_CHECKPOINT_INVALID");
  const base = checkpoint.state;
  const firstRenewal = ledger.state.renewalEvents?.[0];
  const sessionBase = firstRenewal
    ? history.rows[firstRenewal.approval.generation]?.state
    : base;
  if (!sessionBase) throw new Error("SESSION_RENEWAL_CHECKPOINT_INVALID");
  const start = Math.min(
    c.generation,
    firstRenewal?.approval.generation ?? c.generation,
  );
  let prior = history.rows[start].state;
  for (const row of history.rows.slice(start)) {
    const s = row.state;
    validateSessionProgress(sessionBase, prior, s);
    for (const e of s.renewalEvents ?? []) {
      const anchor = history.rows[e.approval.generation];
      if (
        e.approval.ledgerIdentity !== history.identity ||
        !anchor ||
        anchor.digest !== e.approval.digest ||
        e.approval.generation >= row.generation ||
        anchor.state.entries.length !== 7 ||
        !anchor.state.reconciliations?.length ||
        anchor.state.bytes !== 474 ||
        anchor.state.allocations !== 1 ||
        Object.keys(anchor.state.resources).length !== 0 ||
        (e.approval.round === 2 &&
          (anchor.state.renewalEvents?.length !== 4 ||
            anchor.state.renewalEvents.some((x) => x.state !== "completed") ||
            (["A", "B"] as const).every((actor) =>
              usableSession(
                anchor.state.sessions[actor]!.token,
                actor as "A" | "B",
                Date.parse(e.approval.issuedAt),
                1800000,
              ),
            )))
      )
        throw new Error("SESSION_RENEWAL_CHECKPOINT_INVALID");
    }
    if (
      s.entries.length > prior.entries.length + 1 ||
      (s.entries.length > prior.entries.length &&
        prior.entries.at(-1)?.state === "reserved")
    )
      throw new Error("CONTINUATION_SEQUENCE_INVALID");
    for (const [ref, old] of Object.entries(prior.resources)) {
      const next = s.resources[ref];
      if (
        !next ||
        next.url !== old.url ||
        next.path !== old.path ||
        next.actor !== old.actor ||
        next.offset < old.offset ||
        (old.complete && !next.complete)
      )
        throw new Error("CONTINUATION_HISTORY_INVALID");
    }
    if (
      s.allocations < prior.allocations ||
      s.bytes < prior.bytes ||
      s.entries.length < prior.entries.length ||
      s.allocations > 3 ||
      s.bytes > 6325536 ||
      s.allocations - base.allocations > c.maxAdditionalAllocations ||
      s.bytes - base.bytes > c.maxAdditionalBytes ||
      s.halted !== base.halted ||
      JSON.stringify(s.reconciliations) !== JSON.stringify(base.reconciliations)
    )
      throw new Error("CONTINUATION_HISTORY_INVALID");
    for (const [ref, resource] of Object.entries(s.resources)) {
      if (
        resource.actor !== "A" ||
        resource.path !== STAGES[9].path ||
        ![0, 6291456, 6292480].includes(resource.offset) ||
        resource.complete !== (resource.offset === 6292480) ||
        !s.entries.some(
          (e) =>
            e.id === "tus-create-A" &&
            e.resourceRef === ref &&
            e.state === "completed",
        )
      )
        throw new Error("CONTINUATION_HISTORY_INVALID");
    }
    for (const [i, e] of s.entries.entries()) {
      if (i < 7) {
        // Owner-info may legitimately enrich A00 after its immutable request record.
        const original = base.entries[i];
        const copy = { ...e };
        if (
          i === 4 &&
          s.entries.some(
            (x) => x.id === "owner-info-rest" && x.state === "completed",
          )
        ) {
          if (e.owner !== undefined && e.owner !== USERS.A.id)
            throw new Error("CONTINUATION_HISTORY_INVALID");
          copy.owner = original.owner;
          copy.ownerSource = original.ownerSource;
          copy.cleanup = original.cleanup;
          if (original.owner === undefined) delete copy.owner;
          if (original.ownerSource === undefined) delete copy.ownerSource;
        }
        if (JSON.stringify(copy) !== JSON.stringify(original))
          throw new Error("CONTINUATION_HISTORY_INVALID");
      } else {
        const stage = STAGES[i];
        if (
          !stage ||
          stage.id !== c.stages[i - 7] ||
          e.id !== stage.id ||
          e.actor !== stage.actor ||
          e.method !== stage.method ||
          e.purpose !== stage.purpose ||
          e.path !== ("path" in stage ? stage.path : undefined) ||
          e.bodyBytes !== stage.maxBytes ||
          e.allocation !==
            ["wrong-owner-upload", "tus-create"].includes(stage.purpose) ||
          !["reserved", "completed"].includes(e.state) ||
          (i < s.entries.length - 1 && e.state !== "completed")
        )
          throw new Error("CONTINUATION_SEQUENCE_INVALID");
        const old = prior.entries[i];
        if (old) {
          const immutable = (x: Entry) => [
            x.id,
            x.actor,
            x.path,
            x.method,
            x.purpose,
            x.bodyBytes,
            x.allocation,
            x.allocationAttempt,
            x.cumulativeBytes,
          ];
          if (
            JSON.stringify(immutable(e)) !== JSON.stringify(immutable(old)) ||
            (old.state === "completed" && e.state !== "completed") ||
            (old.status !== undefined && old.status !== e.status) ||
            (old.resourceRef !== undefined && old.resourceRef !== e.resourceRef)
          )
            throw new Error("CONTINUATION_HISTORY_INVALID");
        }
      }
    }
    prior = s;
  }
  if (intent) {
    if (ledger.state.renewalEvents?.some((e) => e.state !== "completed"))
      throw new Error("SESSION_RENEWAL_INTERRUPTED");
    const index = ledger.state.entries.length - 7 - Number(reserved);
    if (intent.id !== c.stages[index] || ledger.isCompleted(intent.id))
      throw new Error("CONTINUATION_STAGE_NOT_APPROVED");
    const validation = validateIntent(intent);
    const n = reserved ? 0 : (intent.body?.byteLength ?? 0);
    if (
      ledger.state.allocations +
        (reserved ? 0 : Number(validation.allocation)) >
        base.allocations + c.maxAdditionalAllocations ||
      ledger.state.bytes + n > base.bytes + c.maxAdditionalBytes ||
      ledger.state.bytes + renewalBytes(ledger.state) + n > 6325536
    )
      throw new Error("CONTINUATION_BUDGET_EXHAUSTED");
  }
}
