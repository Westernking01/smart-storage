# Private first-wave continuation helper

Result: **READY FOR CONTROLLED CONTINUATION** (local implementation). No live Auth/Storage request, real approval creation, real-ledger access/mutation, real-credential decryption or permission repair occurred in this task. The user's successful normal-PowerShell ACL validation and two-session renewal are user-reported execution evidence, not newly inspected facts here.

## Exact normal PowerShell command

Close VS Code/Codex first. In normal PowerShell under the same Admin Windows account, run:

```powershell
Set-Location 'C:\Users\Admin\Desktop\NEW\smart-storage'
node .cache/provider-runner/build/continuation-helper-cli.js --execute
```

The compiled helper is prepared by the local runner compiler. If compiled files were removed, first run `node node_modules/typescript/bin/tsc --project experiments/storage/provider-runner/tsconfig.json` and proceed only on exit code 0. Never initialize the ledger or run earlier one-shot execution/reconciliation helpers.

Expected prompt:

```text
Target mdyiczsuddpqgjtfofgs / smart-storage-feasibility / p14b-20261011-c40e8e03. Execute exactly 10 remaining Storage stages; additional limits 2 allocations / 6,292,512 stage-body bytes; no Auth, retry or cleanup. Type EXECUTE TEN STORAGE STAGES to authorize:
```

Type **EXECUTE TEN STORAGE STAGES** only if you approve that exact scope. Any other response stops before approval creation or requests. The helper revalidates after confirmation, creates an exclusive external current-user/SYSTEM-only schema-v2 approval with unpredictable ID and at most 30-minute validity, and checks the saved contents/ACLs. You never construct JSON or paste an approval ID.

The helper uses the canonical existing DPAPI ledger, current checkpoint and process lock. It verifies original seven-stage evidence, four completed renewal events and the entire renewal history from the renewal approval's original checkpoint, exactly ten pending stages, 1 allocation/474 stage bytes, no existing TUS resource, and unchanged cumulative/additional caps. Both verified ordinary tokens must remain usable for the approval window. If prerequisites fail, stop; no repairs, automatic renewal or reset occur. The configured URL/publishable key are checked locally; no extra remote health, Auth or Storage inventory requests are added to this fixed ten-stage scope.

## Private invocation and execution

The compiled CLI now exposes an import-safe runCli function. The helper calls it in the same process with only ['--execute'] and private in-memory context. The opaque confirmation, checkpoint, JWTs and approval contents never enter process arguments, stdout, environment variables or child-node invocation. The ledger lock stays held across confirmation and CLI execution. Existing Windows DPAPI subprocesses receive private data only through stdin; their argument lists contain static scripts, not tokens. Normal user/SYSTEM ACL protection is retained. No real credential file is needed or decrypted: private continuation refuses authentication replay and uses the two already verified usable sessions.

The existing Runner/ProviderHttp enforce exact intents, durable attempted-byte/allocation reservation, no redirects/retries, per-request expiry, strict Location/offset binding, owner checks and security stop conditions. The helper also checks private approval contents and ledger/file ACLs before requests. The original expired approvals and renewal evidence remain untouched. No cleanup mode is invoked.

The only live stages are wrong-owner-B, anonymous-read, tus-create-A, tus-head-zero, tus-part-first, tus-head-recovery, tus-part-tail, tus-head-complete, owner-info-rest and owner-info-tus. Wrong-owner 32-byte attempt consumes one allocation even when denied. TUS creation consumes the other; nonfinal PATCH is exactly 6,291,456 bytes, final PATCH 1,024 bytes. Every Auth renewal body remains separately included in cumulative totals; no counter reset or refund.

## Output and honest success criteria

Each completed request prints only stage ID, status and cumulative counters. The final sanitized JSON includes:

- classification FIRST WAVE PASSED only if all ten stages completed, one bound TUS resource is complete at offset 6,292,480, and both object ownerships are verified.
- additionalAllocations 2; additionalStageBodyBytes 6292512; attemptedAllocations 3; stageBodyBytes 6292986.
- attemptedRenewalBodyBytes from the actual renewal journal and total attempted bytes including those Auth bodies, within 6325536.
- tusOffsets for successful HEAD/PATCH stages: 0, 6291456, 6291456, 6292480, 6292480; tusComplete true; ownershipVerified true; cleanupExecuted false; adr041 UNRESOLVED.
- privateResultFile pointing to an ACL-validated external result.json next to the new approval.

No token, password, approval ID, private TUS URL, raw checkpoint hash or file bytes are printed. A00 remains; completed A02 remains. Unexpected wrong-owner success is reported as a possible unauthorized write. Object metadata/counts are not independently refreshed by extra calls. No new TUS digest verification is claimed because it is not one of the approved ten stages.

If an ordinary owner-info response omits ownership, the helper reports FIRST WAVE STOPPED / INCOMPLETE with OWNER_VERIFICATION_PENDING; policy installation and TUS completion are not ownership certification. It does not invent owner evidence or add an unapproved request. Non-cross-read HTTP 400 denials remain fail-closed, as do unknown Location/offset/identity/network/approval/ledger outcomes. FIRST WAVE FAILED distinguishes observed authorization, offset or owner failures where supported. ADR-041 remains unresolved even on success.

## If the helper stops

Do not rerun --execute, renew again, manually replay requests, delete objects, change policies or clear locks/pending files. Preserve the approval, result, journal and snapshot. A normal exception produces sanitized stop code and a private report when durable state can be verified. An abrupt termination or incomplete commit may prevent report creation; the helper does not manufacture a final state.

Read-only inspection command:

```powershell
node .cache/provider-runner/build/continuation-helper-cli.js --inspect
```

This checks ACLs, acquires the process lock and loads the existing encrypted state, then prints redacted stage statuses, consumed budgets, TUS offsets/completion and pending ownership. No approval, credential decryption, network request, cleanup or journal update occurs. If ACLs, an existing lock, pending commit or integrity failure prevents inspection, retain that failure and request reconciliation; do not remove artifacts. The historical DENIAL_NOT_ESTABLISHED string for cross-read-B remains evidence, while continuationBlocked false indicates its validated reconciliation.

## Focused validation

Disposable tests cover scope/checkpoint binding, renewed history, exact confirmation/cancellation, no secret-bearing process arguments, ACL failure, session expiry, repeated execution refusal, redaction, ownership-pending output and compiled inspection preserving encrypted fixture bytes. Existing runner and native DPAPI/ACL suites remain mandatory. No unrelated build/browser suite or production application change is needed.

Final checks: 97 runner tests and 7 native Windows tests passed; TypeScript, runner compilation, ESLint and formatting passed. Native fixtures avoid even existence checks on the real ledger directory. No production dependencies or manifest change. Initial mock-call typing and time-dependent token fixture errors were corrected and checks rerun. Live provider execution remains exclusively the user's later confirmed normal-PowerShell action.

## Controlled second-renewal recovery (2026-10-13)

The latest user-authorized local implementation supersedes the earlier blanket second-renewal prohibition only through the explicit --renew-then-continue path. Exactly one additional four-request Auth round requires a fully completed identity-verified first round, zero Storage continuation progress, a fresh private round-2 checkpoint-bound approval and separate human confirmation. Storage still needs its own ten-stage confirmation with additional limits 2 allocations/6292512 bytes. Both histories and cumulative Auth accounting are preserved; no third renewal, retry, reset, cleanup or lifetime-threshold reduction. Implementation uses disposable fixtures only; real ledger, credentials and provider remain untouched. See experiments/storage/provider-runner/renew-then-continue-report.md for the exact normal-PowerShell procedure and evidence limits. ADR-041 remains unresolved.
