# Provider runner — Task 1.4B.0

Preparation complete; provider execution is unapproved. No dependencies or production code changed. Run from the repository root with installed TypeScript/Vitest tooling:

```powershell
node node_modules/typescript/bin/tsc --project experiments/storage/provider-runner/tsconfig.json
node .cache/provider-runner/build/cli.js
node node_modules/vitest/vitest.mjs run --config experiments/storage/provider-runner/vitest.config.ts
```

Default invocation prints the [fixed matrix](../provider-test-matrix.md), makes zero provider requests, reads no credentials/configuration and modifies no ledger. Runner tests use mocked HTTP and disposable encrypted local fixtures. Native Windows credential/ACL adapters and real provider routes have not been exercised by this preparation.

## Accelerated local recovery update

[Recovery report](local-recovery-report.md) and [receipt](local-recovery-results.json) supersede the earlier unimplemented-reconciliation status. Exact denial has been reconciled locally through one appended encrypted generation; original failure/history/counters remain. No live continuation ran. Approval has expired; do not reuse or auto-renew it. Explicit new execution authorization is required.

The planner skips completed/reconciled stages and bounds the ten remaining stages to two allocation attempts and 6,292,512 bodies, within 2 / 6,325,062 remaining. Error envelopes are bounded/sanitized; only the validated cross-read-B exception accepts outer 400. All other stop conditions remain.

[Guarded Windows repair](repair-ledger-acl.ps1) targets only this exact known development directory/SID and marker/journal/snapshot, preserves bytes and rejects locks, pending commits, links, unknown owners/ACEs/files. A sandbox ACE may reappear between tool invocations: run the explicitly approved repair immediately before subsequent ledger/CLI access in the same normal Windows invocation. Never weaken the validator or repair unrelated resources. Do not rerun the one-shot reconciliation helper.

Focused test commands above now cover 54 runner tests and five native Windows tests. Native tests use disposable data only; no actual credential-store decryption or provider request is required.

## Task 1.4B.1 native preflight update

[Readiness report](preflight-readiness.md) classifies the fixed first wave READY FOR EXPLICIT AUTHORIZATION. No active approval exists. The native Windows adapter now has disposable integration evidence, superseding the preparation-only untested status below. The exact payload/manifest/budgets are unchanged; exact TUS chunk sizes and reservation allocation flags are now enforced explicitly.

The default Vitest runner command now includes four disposable native Windows tests, which require the loaded Windows user context. Restricted sandbox DPAPI may report PRIVATE_STORE_FAILURE; use the normal user context for these local-only tests, never relax ACLs/encryption. For mocked-only checks:

```powershell
node node_modules/vitest/vitest.mjs run --config experiments/storage/provider-runner/vitest.config.ts experiments/storage/provider-runner/runner.test.ts
```

The Windows suite overrides USERPROFILE only within its disposable test process, never reads actual credentials, initializes only a temporary ledger and removes only its verified temporary fixtures. Do not use that override in a real run. Actual credentials and live TUS compatibility remain untested; readiness is not execution approval.

## Protected local state

Future explicit `--initialize-ledger` creates only local state at `%USERPROFILE%/smart-storage-provider-p14b-20261011-c40e8e03`. It refuses an existing directory and never resets budgets. This directory has not been initialized during preparation. DPAPI CurrentUser encrypts the entire ledger, including JWTs and private TUS URLs; restrictive Windows ACLs permit current SID and SYSTEM. Passwords are retrieved only after an execution gate from the previously created external `completed.dpapi` credential store. Nothing is stored in the repository, arguments or reports except nonsecret filenames/opaque confirmation IDs. No service-role key is read or used. The adapter loads only the exact project's public URL and publishable key from `.env.local`.

One immutable marker and an exclusive `wx` process lock bind the canonical run. Each request reservation appends an encrypted hash-chained journal generation, fsyncs it, writes/fsyncs a pending snapshot and atomically renames the snapshot before transport. Native transport rechecks the durable reservation. Counters are reconstructed from entries on restart. Missing, truncated or inconsistent journal/snapshot, pending files, reserved/ambiguous requests or a held lock fail closed. No automatic stale-lock removal/recovery exists. File fsync and rename follow [Node filesystem APIs](https://nodejs.org/api/fs.html); process-fault tests do not certify physical power-loss durability, hostile same-user rollback or disk corruption recovery.

Ledger entries record run/bucket/path/actor, attempt number, method/purpose, intended and cumulative bytes, HTTP status, resource reference, offset, owner/source, completion/failure/ambiguity and cleanup state. Public summaries expose request IDs, actor labels, slot numbers, counters and safe error codes, never tokens, URLs, UUIDs, fixture contents or raw errors.

## Future approval gate and commands

No executable approval file is supplied. After explicit user approval, a private ACL-restricted JSON approval file must contain: kind `storage-provider-execution`; an opaque id of at least 16 characters; exact project, bucket and run (without trailing slash); `manifestHash` from the dry-run; a future `expiresAt`; purposes `login`, `identity`, `rest-upload`, `download`, `cross-read`, `wrong-owner-upload`, `anonymous-read`, `tus-create`, `tus-head`, `tus-part`, `owner-info`; and `acknowledgedRuntimeUncertainties: true`. Its confirmation ID must match, and every request rechecks expiry/scope. This local record represents explicit approval; generating one is not a substitute for obtaining approval.

Only after that approval and fresh read-only prerequisites:

```powershell
node .cache/provider-runner/build/cli.js --initialize-ledger
node .cache/provider-runner/build/cli.js --execute --approval-file <private-approval-json> --confirm <opaque-id> --credentials-file <external-completed.dpapi>
```

The first remote request is Auth password sign-in, not an upload. Sessions must resolve to the approved ordinary identities; no refresh/retry/substitution occurs. A completed, acknowledged stage is skipped on normal resume. An uncertain response or interrupted write stops for approved reconciliation; restarting never silently spends a new budget.

Local-only inspection, after a ledger exists:

```powershell
node .cache/provider-runner/build/cli.js --cleanup-preview
node .cache/provider-runner/build/cli.js --owner-evidence <private-catalog-evidence-json>
```

Owner evidence shape is `{ "run": "p14b-20261011-c40e8e03", "records": [{ "path": "<exact-recorded-path>", "owner": "<approved-owner-UUID>" }] }`, at most two records. Obtain evidence through a separately approved read-only audit. This command records the source as user-supplied, never invents provider evidence.

Cleanup preview contains only recorded, completed, allowlisted allocations with verified matching ownership; incomplete TUS and denial targets are ineligible. Preview emits actor/slot and makes zero requests. The CLI has no deletion mode. Core deletion support independently requires a `storage-provider-cleanup` approval scoped only to cleanup and eligible ledger paths; execution approval is rejected. Future remote cleanup wiring/execution needs separate review and approval. An HTTP DELETE acknowledgment alone does not prove physical or incomplete-TUS-resource removal.

## Limits and unresolved behavior

Fixed caps are 12 allocation attempts and 33,554,432 attempted body bytes, charged before sending and never refunded. Sequential busy guards and the whole-process lock prevent parallel spending. Changing the manifest invalidates existing state; future extensions need a reviewed migration preserving all counters, not a new ledger/prefix. No alternate endpoint, signed capability or privileged route is available.

Mocked checks establish local safeguards only. Live TUS Location format, HEAD authorization, provider-owned completion under restrictive UPDATE, owner metadata availability, interrupted resource reconciliation and native Windows adapter behavior remain unverified. This first wave cannot prove ADR-041 reservation enforcement or production upload security. Stop after preparation; no Task 1.5 or Phase 2 authorization follows.

## Task 1.4B.2C continuation approval

Schema version 2 is required for the reconciled continuation. See [safeguards, blocking ACL evidence and private execution procedure](continuation-approval-report.md). continuationCheckpoint returns binding data only; it does not create approval files or mutate the ledger. Old approvals cannot authorize this continuation. Never initialize or reconcile the existing ledger again. No live approval or execution is authorized by this local task.

## Expired session renewal

Use the [normal PowerShell procedure](session-renewal-report.md) for separately confirmed Auth-only renewal. The command is interactive, requires expired verified ordinary sessions, and issues exactly four Auth requests after a fresh ledger-bound approval. It never executes Storage continuation. Historical sessions/requests remain in the encrypted journal; renewal attempted body bytes are separately recorded within unchanged cumulative caps. Interrupted renewal requires review, not retries.

## Final private continuation helper

Use [the single normal-PowerShell command and confirmation](private-continuation-report.md). The import-safe compiled CLI is called in-process with a shared lock and private context, so no confirmation ID is passed in process arguments. Only renewed, usable sessions and exactly ten pending stages qualify. --inspect prints redacted local evidence without network or journal mutation. Do not rerun --execute after a stop or clear recovery artifacts.


## Controlled second-renewal recovery (2026-10-13)

The latest user-authorized local implementation supersedes the earlier blanket second-renewal prohibition only through the explicit --renew-then-continue path. Exactly one additional four-request Auth round requires a fully completed identity-verified first round, zero Storage continuation progress, a fresh private round-2 checkpoint-bound approval and separate human confirmation. Storage still needs its own ten-stage confirmation with additional limits 2 allocations/6292512 bytes. Both histories and cumulative Auth accounting are preserved; no third renewal, retry, reset, cleanup or lifetime-threshold reduction. Implementation uses disposable fixtures only; real ledger, credentials and provider remain untouched. See experiments/storage/provider-runner/renew-then-continue-report.md for the exact normal-PowerShell procedure and evidence limits. ADR-041 remains unresolved.


## Interrupted second renewal investigation (2026-10-13)

Current outcome: BLOCKED — AMBIGUOUS AUTH REQUEST pending a normal-Windows --diagnose-renewal read-only report. User-reported counters are 1 allocation, 474 stage bytes, 327 renewal bytes, 801 total bytes, zero Storage continuation. The extra 109 bytes do not establish delivery or success. The native dispatch marker precedes fetch, and no durable response-received marker exists. A minimal completion-error correction reloads integrity before appending failure evidence and preserves completed responses. No real ledger/credentials/approvals were accessed, no provider requests occurred, and no reconciliation, third renewal, retry, cleanup or continuation is authorized. See experiments/storage/provider-runner/interrupted-renewal-report.md for the exact diagnostic command and evidence requirements. Earlier READY implementation statements are historical; runtime recovery remains blocked. ADR-041 unresolved.
