# Controlled second renewal and immediate continuation

Implementation scope: disposable fixtures only. No real ledger, credential store or approval was accessed; no live Auth or Storage request occurred. ADR-041 remains unresolved.

The user reports a completed first renewal (four Auth requests, 218 body bytes), seven original stages, zero Storage continuation requests, one allocation, 474 stage bytes and 692 total attempted bytes. These are user-observed, not independently decrypted findings.

## Authorization and evidence

The new `--renew-then-continue` path accepts exactly four completed first-renewal records with independently verified ordinary A/B identities, exact original checkpoint and zero continuation progress. At least one verified session must lack the unchanged 30-minute remaining lifetime. First-round approvals cannot authorize round two. A fresh private, checkpoint-bound approval marked round 2 is created only after explicit Auth confirmation; it expires within 30 minutes. Only A login/identity then B login/identity are allowed, with durable reservation and dispatch before each request. No third renewal or replay is supported.

The original four events and all encrypted journal rows remain immutable. Four additional events are appended; current sessions change only after each new identity verification. Historical checkpoint validation walks both rounds, verifies the second anchor contains the completed first round, and binds prior sessions to its first verified results. Completed or failed/ambiguous evidence cannot be overwritten. Interrupted commits, partial renewals, changed files, expiry or unknown responses stop without retries or resets.

Auth body accounting is cumulative across both rounds: maximum 32,550 bytes, leaving 32,332 after the user-reported 218. Actual login body sizes are validated privately before any request; per-login maximum 16,384. Each operation rechecks approval, ACLs, encrypted history and cumulative accounting. Original first-wave total remains 6,325,536 bytes. Storage authorization remains separately confirmed: ten ordered stages, maximum two additional allocations and 6,292,512 additional stage-body bytes. Seven completed stages are never replayed.

Both approvals use fresh unpredictable IDs and external current-user/SYSTEM-only files. Secrets stay inside the same process or private encrypted state; no confirmation ID is passed as a process argument. The ledger is locked throughout both phases. No ACL repair, ledger initialization, cleanup or global configuration change occurs.

## Token lifetime finding

The existing helper requires more than 1,800 seconds remaining before its 30-minute Storage approval. This requirement is unchanged. [Official CLI configuration](https://supabase.com/docs/guides/local-development/cli/config#authjwt_expiry) documents a 3,600-second default, compatible with immediate continuation. [Auth sessions documentation](https://supabase.com/docs/guides/auth/sessions) distinguishes access-token expiry from session duration. The actual hosted project's configured expiry and the reason for its previous stop remain unverified: no real token/configuration was inspected. Delay, configured lifetime and clock skew remain possible explanations, not established causes.

The helper now prints only numeric remaining seconds and issued lifetime (`exp - iat`, or null if unavailable), never claims, JWTs or timestamps. If fresh tokens still cannot satisfy the requirement, it stops before Storage; there is no third renewal or threshold reduction. Shorter lifetimes require separate investigation.

## Single normal Windows PowerShell procedure

Close VS Code/Codex and use normal PowerShell as the same Admin account:

```powershell
Set-Location 'C:\Users\Admin\Desktop\NEW\smart-storage'
node .cache/provider-runner/build/continuation-helper-cli.js --renew-then-continue
```

Read the displayed exact development target and scopes. First type `AUTHORIZE SECOND SESSION RENEWAL` to authorize four Auth requests only. After both identities are verified, type `EXECUTE TEN STORAGE STAGES` at the separate prompt showing ten stages, two allocations and 6,292,512 bytes. Respond promptly to minimize token-age delay. The second approval binds the new checkpoint; cancellation does not authorize Storage.

Successful output includes `SECOND_SESSIONS_RENEWED_AND_IDENTITY_VERIFIED`, sanitized lifetime diagnostics, and ultimately `FIRST WAVE PASSED`, actual HTTP results/offsets/accounting and a private result-file path. Installation of policies or completion of this wave does not resolve ADR-041 or certify production security.

On any stop, preserve all state. Inspect locally without provider requests:

```powershell
node .cache/provider-runner/build/continuation-helper-cli.js --inspect
```

Do not rerun renewal after a partial or completed second attempt, clear lock/pending files, reset counters, manually construct approval JSON or retry requests. A completed second renewal with no Storage progress may use the existing separately confirmed `--execute` mode only while its verified sessions still satisfy the lifetime requirement; that mode never renews Auth. Any ambiguous/partial operation needs separate reconciliation authorization.

## Validation

Focused mocked runner and disposable native Windows checks, runner compilation, application type checking, ESLint and formatting are recorded in the current progress entry. No production build or unrelated browser/full-project suite is needed for this isolated runner change. Live provider responses, current resources and configured lifetime remain execution-time uncertainties.

Final local checks: 102 runner tests and 7 native Windows tests passed; runner compilation, typecheck, ESLint and formatting passed. Classification: READY FOR CONTROLLED RENEW-THEN-CONTINUE. No live execution was performed.

## Interrupted second renewal investigation (2026-10-13)

Current outcome: BLOCKED — AMBIGUOUS AUTH REQUEST pending a normal-Windows --diagnose-renewal read-only report. User-reported counters are 1 allocation, 474 stage bytes, 327 renewal bytes, 801 total bytes, zero Storage continuation. The extra 109 bytes do not establish delivery or success. The native dispatch marker precedes fetch, and no durable response-received marker exists. A minimal completion-error correction reloads integrity before appending failure evidence and preserves completed responses. No real ledger/credentials/approvals were accessed, no provider requests occurred, and no reconciliation, third renewal, retry, cleanup or continuation is authorized. See experiments/storage/provider-runner/interrupted-renewal-report.md for the exact diagnostic command and evidence requirements. Earlier READY implementation statements are historical; runtime recovery remains blocked. ADR-041 unresolved.
