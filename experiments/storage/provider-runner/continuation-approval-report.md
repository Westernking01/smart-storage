# Task 1.4B.2C - Continuation approval safeguards

Result: **BLOCKED** (2026-10-13). Local implementation is complete; the real ledger ACL prerequisite failed. No live approval, Auth request, Storage request, cleanup, or provider mutation occurred.

## Safeguards and compatibility

Schema version 2 binds exact project/bucket/run/unchanged manifest, issue/expiry times (at most 30 minutes), the ten ordered continuation IDs, and the stricter additional caps: 2 allocations and 6,292,512 body bytes. Identity is derived from the canonical ledger directory, unchanged marker, and genesis envelope. An initial generation/digest anchors the existing encrypted journal, not a static final-state hash.

Before reservation and at the HTTP adapter boundary, the runner reloads and validates the encrypted chain/snapshot, initial checkpoint, immutable original entries/reconciliation/sessions, monotonic counters, ordered single-stage progression, resource progression and cumulative/additional caps. Completed stages cannot replay; old approvals cannot authorize a reconciled continuation. Expiry is checked again immediately before fetch. Interrupted reservations remain blocked. Original ledger schema and manifest are unchanged; no real journal generation was appended.

Owner-info can enrich A00 ownership without changing its immutable request history. Mocked ten-stage continuation validates this progression. No broader HTTP 400 denial classifier was introduced. Coverage maps to T-05/T-08 and FR-05/06/09: these are local safeguards, not live TUS acceptance.

## Actual readiness checks

Authenticated management connector: project mdyiczsuddpqgjtfofgs, ACTIVE_HEALTHY. Development isolation remains user-confirmed. Read-only SELECT metadata returned the exact private bucket, 8,388,608-byte cap, single application/octet-stream MIME, both confirmed ordinary nonanonymous identities, and exactly A00 (256 bytes, owner User A). Exactly four Storage policies; all definitions compare exactly with retained provider baseline after role-array formatting normalization. No unexpected run objects. No TUS requests were made; absence of hidden temporary TUS resources is not independently certified by object metadata alone.

Real directory inspection failed strict ACL validation (PRIVATE_STORE_FAILURE). The extra explicit Allow ACE is CodexSandboxUsers SID S-1-5-21-3058023354-1746979206-3201508519-1002, ReadAndExecute/Synchronize (1179817). Admin and SYSTEM FullControl remain. No permissions were changed. Marker/journal/snapshot bytes compare unchanged before/after inspection. Inspection stopped before ledger decryption; current ledger integrity, checkpoint and session expiry remain unverified. Last successful historical receipt reports consumed 1 allocation/474 bytes and the ten remaining stages. New execution cap is additional 2/6,292,512, not the larger historical remaining capacity of 6,325,062.

Evidence: [local receipt](continuation-readiness.json), [fresh policy readback](continuation-provider-policies.json), [historical recovery receipt](local-recovery-results.json).

## Checks

Focused runner suite: 74 tests, including 20 new continuation cases. Native Windows suite: 5 tests passed using disposable fixtures, including rejection of sandbox principals, protected ACL repair and DPAPI. TypeScript, runner compilation, ESLint and formatting are checked after final changes. No production build or unrelated browser tests needed for this isolated experimental runner change. Initial test expectation and test-only TypeScript path narrowing failures were corrected and checks rerun; final results are recorded in progress.

## Procedure for separately approved execution

1. Resolve the exact ledger ACL blocker without weakening validation; validate immediately in the same normal Windows user invocation. Do not clear locks or pending commits. Reload existing ledger; do not initialize it or rerun reconciliation.
2. Refresh read-only prerequisites and validate stored ordinary session expiry privately. If expired, stop: this ten-stage scope does not authorize another sign-in or refresh.
3. Obtain separate explicit execution authorization. Call continuationCheckpoint(ledger) under its lock. Generate a new cryptographically unpredictable confirmation ID and create a new external, current-user/SYSTEM-only approval file (exclusive creation). Use schemaVersion 2, issuedAt now, expiresAt at most 30 minutes later, existing target/manifest, purposes from the ten remaining stages, acknowledgedRuntimeUncertainties true, and the exact checkpoint fields. Preserve the expired approval. Do not print checkpoint/confirmation secrets.
4. Validate with approve and assertContinuation before execution. In the same private helper process, invoke the compiled CLI with --execute --approval-file <new-private-file> --confirm <opaque-id> --credentials-file <existing-protected-store>. Keep the confirmation out of visible command output; no new credentials are read when both sessions are already verified. Exact CLI: node .cache/provider-runner/build/cli.js with those flags, launched privately by the helper.
5. Execute only the ten ordered stages; any failure stops without retry, replacement allocation, cleanup or ledger reset. Retain all state/evidence.

TUS creation/HEAD/PATCH behavior, strict Location format, ordinary owner-info availability and non-cross-read HTTP 400 denial behavior remain runtime uncertainties. ADR-041 remains unresolved. No Task 1.5 or Phase 2.

Final helper supersedes manual secret-bearing CLI invocation instructions above: use [private-continuation-report.md](private-continuation-report.md) and the compiled interactive helper. No JSON construction or --confirm argument is required. Strict Storage scope and approval validation remain unchanged.

## Controlled second-renewal recovery (2026-10-13)

The latest user-authorized local implementation supersedes the earlier blanket second-renewal prohibition only through the explicit --renew-then-continue path. Exactly one additional four-request Auth round requires a fully completed identity-verified first round, zero Storage continuation progress, a fresh private round-2 checkpoint-bound approval and separate human confirmation. Storage still needs its own ten-stage confirmation with additional limits 2 allocations/6292512 bytes. Both histories and cumulative Auth accounting are preserved; no third renewal, retry, reset, cleanup or lifetime-threshold reduction. Implementation uses disposable fixtures only; real ledger, credentials and provider remain untouched. See experiments/storage/provider-runner/renew-then-continue-report.md for the exact normal-PowerShell procedure and evidence limits. ADR-041 remains unresolved.
