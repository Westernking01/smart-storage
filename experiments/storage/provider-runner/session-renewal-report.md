# Controlled renewal of expired continuation sessions

Implementation result: **READY FOR CONTROLLED SESSION RENEWAL**. This is local implementation readiness, not a claim that real sessions were renewed or current provider state was independently verified.

## Scope and safeguards

The renewal CLI permits only A password sign-in, A GET /auth/v1/user, B password sign-in, B GET /auth/v1/user, sequentially. It uses the existing official Auth endpoints with the publishable key and the external DPAPI CurrentUser credential adapter. There is no refresh-token persistence, privileged fallback, automatic retry, redirect, Storage operation, account creation or cleanup.

A separate version-1 Auth-only approval binds the exact project/bucket/run/unchanged manifest, stable existing-ledger identity and initial checkpoint, both fixed ordinary identities, a random opaque confirmation ID and an expiry of at most 30 minutes. Normal interactive PowerShell execution requires explicit typed confirmation before a new private approval is created. The approval uses a fresh external directory with only current-user/SYSTEM ACLs. Existing ledger and credential directory permissions are never repaired or changed by this command.

Both old tokens must have the expected ordinary identity/role, verified evidence and actual expired exp claims. A verified flag alone never permits reuse. Each new token must have matching ordinary claims and valid expiry; GET /auth/v1/user must independently return the exact approved UUID/email, authenticated role and is_anonymous false. Only then is the current session replaced. Decoding claims is a safety filter, not signature or identity verification.

Old tokens remain in the immutable encrypted journal and renewal evidence. Optional renewalEvents extend the existing ledger schema without rewriting history. Each request is durably reserved; the native adapter records dispatched before HTTP and refuses reused reservations. Approval/ACL/journal/checkpoint validation precedes requests. Invalid response, identity mismatch, interrupted commit/network, expired approval or incomplete renewal stops without retry. A partially renewed run requires separate evidence reconciliation; do not rerun the command, reset counters or reconstruct missing evidence.

Schema-v2 Storage approval scope remains exactly ten stages and two additional allocations/6,292,512 stage-body bytes. Session-history validation accepts only audited renewal progression anchored to the original checkpoint, including when a fresh Storage checkpoint is issued after renewal. Any unauthorized mutation, missing evidence, changed history, stage replay or reset fails closed. Renewal never sends or recreates the seven completed requests.

## Accounting

Original seven-stage counters stay 1 allocation/474 bytes; original entries and their cumulative fields remain unchanged. Auth renewal bodies are additionally recorded as attempted bytes in renewalEvents; GET identity bodies are zero. Summaries now report stageBodyBytes, attemptedRenewalBodyBytes and their total. No attempted bytes are refunded on denial or interruption.

The maximum dedicated renewal-body budget is **32,550 bytes**, the unused first-wave headroom after reserving all ten remaining stage bodies: 6,325,536 - 474 - 6,292,512. Each login body is also capped at 16,384 bytes, and both exact credential body lengths are validated before any request. This does not increase either first-wave or whole-experiment limits. Allocations remain unchanged; later Storage reservation checks include renewal bytes against the original cumulative ceiling. Actual renewal bytes cannot be claimed until execution.

## Normal Windows PowerShell procedure

Do not run this from Codex. Open normal PowerShell as the same Admin Windows account that owns the DPAPI store. Verify current ledger directory/files remain Admin/SYSTEM-only and no lock/pending artifact indicates an interrupted operation. This command will validate those prerequisites and stop rather than repair them.

```powershell
Set-Location 'C:\Users\Admin\Desktop\NEW\smart-storage'
node node_modules/typescript/bin/tsc --project experiments/storage/provider-runner/tsconfig.json
if ($LASTEXITCODE -ne 0) { throw 'Runner compilation failed' }
$renewalCredentialFile = Join-Path $env:USERPROFILE 'smart-storage-feasibility-secrets-20261011-05879c0446444796a320bffc58709281\completed.dpapi'
node .cache/provider-runner/build/renewal-cli.js --renew --credentials-file $renewalCredentialFile
```

Read the fixed target and Auth-only scope, then type **RENEW TWO TEST SESSIONS** at the interactive prompt if you approve those four Auth requests. Do not paste or print passwords, JWTs or approval IDs. The CLI reads the existing protected credentials internally after confirmation and creates its own fresh private approval. No manual ledger or approval JSON editing is needed. It holds the process lock, preserves the expired approvals, verifies both identities, prints only sanitized status/counters and exits. It does not execute Storage continuation.

On any error, stop and preserve journal, snapshot, approval and resources. No automatic recovery or second renewal attempt is supported. An ambiguous request consumes its attempted body budget. A completed renewal may be followed only by separately approved Storage execution with fresh schema-v2 approval and provider prerequisites. Never use this command to replay original login/identity stages.

## Validation and evidence limits

Focused runner tests cover expiry/missing exp, exact identity, old/new checkpoint compatibility, immutable history, replay denial, separate accounting, durable reservation, interrupted renewal/commit and native Auth-only HTTP boundaries with injected disposable responses. Native Windows tests cover DPAPI and protected approval creation/ACL rejection using temporary USERPROFILE fixtures. TypeScript, runner compilation, ESLint and formatting are required checks.

The user independently reports real ledger integrity/checkpoint, ten remaining stages and two tokens expired approximately 19 hours. Those are user-observed facts, not freshly decrypted findings by this implementation task. No real ledger/credentials/approval was opened or modified, and no live Supabase request was made. Current ACL/provider availability remains an execution-time prerequisite. ADR-041 remains unresolved; no later phase or Storage experiment is performed here.

Final checks: 88 runner tests and 6 native Windows tests passed. TypeScript, runner compilation, ESLint and formatting passed. Initial test-only typing/expectation failures were corrected; original whole-experiment budget compatibility was preserved for ledgers without renewal events. Manifest and existing SQL/dependency baselines remain unchanged. No production build, browser suite, real credentials, provider calls or real ledger modification.

## Controlled second-renewal recovery (2026-10-13)

The latest user-authorized local implementation supersedes the earlier blanket second-renewal prohibition only through the explicit --renew-then-continue path. Exactly one additional four-request Auth round requires a fully completed identity-verified first round, zero Storage continuation progress, a fresh private round-2 checkpoint-bound approval and separate human confirmation. Storage still needs its own ten-stage confirmation with additional limits 2 allocations/6292512 bytes. Both histories and cumulative Auth accounting are preserved; no third renewal, retry, reset, cleanup or lifetime-threshold reduction. Implementation uses disposable fixtures only; real ledger, credentials and provider remain untouched. See experiments/storage/provider-runner/renew-then-continue-report.md for the exact normal-PowerShell procedure and evidence limits. ADR-041 remains unresolved.

## Interrupted second renewal investigation (2026-10-13)

Current outcome: BLOCKED — AMBIGUOUS AUTH REQUEST pending a normal-Windows --diagnose-renewal read-only report. User-reported counters are 1 allocation, 474 stage bytes, 327 renewal bytes, 801 total bytes, zero Storage continuation. The extra 109 bytes do not establish delivery or success. The native dispatch marker precedes fetch, and no durable response-received marker exists. A minimal completion-error correction reloads integrity before appending failure evidence and preserves completed responses. No real ledger/credentials/approvals were accessed, no provider requests occurred, and no reconciliation, third renewal, retry, cleanup or continuation is authorized. See experiments/storage/provider-runner/interrupted-renewal-report.md for the exact diagnostic command and evidence requirements. Earlier READY implementation statements are historical; runtime recovery remains blocked. ADR-041 unresolved.
