# Task 1.4B.2 resumption — live first-wave report

Classification: **FIRST WAVE STOPPED / INCOMPLETE**. Seven of seventeen approved stages executed once, sequentially. Last stage **cross-read-B**, HTTP **400**; the runner halted with **DENIAL_NOT_ESTABLISHED**. No retry, alternate client, replacement allocation, denial-status relaxation, cleanup or later-stage request followed.

## Authorization and prerequisites

The user separately authorized resumption using the existing reconciled approval only. At initial check, local time was 2026-10-12 16:44:32.896 Africa/Lagos, leaving 1168 seconds until unchanged expiry 17:04:01.423. The existing ACL, exact scope/purposes/manifest and its stored confirmation ID validated privately. No new approval or expiry extension was made. Before execution the wrapper required at least fifteen minutes of validity; the runner rechecked approval before each request.

[Fresh read-only prerequisites](first-wave-resumption-preflight.json) match the verified prior bucket/identity/policy catalog exactly: connected project mdyiczsuddpqgjtfofgs ACTIVE_HEALTHY, exact private 8388608/octet-stream bucket, two confirmed ordinary test identities, four unchanged policies, zero unexpected policies and zero prefix/bucket objects. Development isolation remains user-confirmed. Read-only MCP was supabase_read_only_user with transaction_read_only on.

No previous ledger existed. The existing --initialize-ledger command created protected encrypted local state; journal/snapshot load verified zero entries, zero allocation attempts and zero attempted bytes under the process lock. Approval bytes were checked unchanged before invoking --execute exactly once. A normal Windows loaded-profile context was used for DPAPI. Existing credential retrieval was private; tokens/passwords/approval ID/URLs were not printed or copied into the repository.

## Observed requests

[Redacted ledger evidence](first-wave-results.json) was loaded from the encrypted durable journal/snapshot after the CLI stopped, observed 2026-10-12T15:47:20.541Z. [CLI output](first-wave-console.txt) is also retained without secrets.

| Stage        | Expected                               | Observed | Outcome                                            |
| ------------ | -------------------------------------- | -------- | -------------------------------------------------- |
| login-A      | 200, ordinary exact-subject token      | 200      | Completed; body 109 bytes charged                  |
| identity-A   | 200, approved ordinary A identity      | 200      | Exact UUID/email/role checks passed                |
| login-B      | 200, ordinary exact-subject token      | 200      | Completed; body 109 bytes charged                  |
| identity-B   | 200, approved ordinary B identity      | 200      | Exact UUID/email/role checks passed                |
| rest-A       | 200/201, A00, 256-byte body, no upsert | 200      | One allocation; upload accepted                    |
| download-A   | 200, exactly 256 fixture bytes/digest  | 200      | Exact byte count and SHA-256 comparison passed     |
| cross-read-B | 401/403/404, denied access to A00      | 400      | Reviewed denial criterion not established; stopped |

Not executed: wrong-owner-B, anonymous-read, tus-create-A, tus-head-zero, tus-part-first, tus-head-recovery, tus-part-tail, tus-head-complete, owner-info-rest, owner-info-tus. No HTTP status or outcome is claimed for them.

HTTP 400 is not an unauthorized successful read, but cannot establish the approved denial assertion. The current adapter retains status, not the raw error response body; the reason for this 400 is unavailable in this report. Do not infer a proven RLS denial or broaden the accepted statuses. Further diagnostic/provider-log or owner-evidence investigation needs separate approved scope. No extra request was made to diagnose or replay the failure.

## Budget and resources

| Accounting                             | Consumed          | Remaining                             |
| -------------------------------------- | ----------------- | ------------------------------------- |
| Strict first-wave allocation attempts  | 1 of 3            | 2                                     |
| Strict first-wave attempted body bytes | 474 of 6,325,536  | 6,325,062                             |
| Whole-run allocation attempts          | 1 of 12           | 11, not additional permission         |
| Whole-run attempted body bytes         | 474 of 33,554,432 | 33,553,958, not additional permission |

474 bytes = 109-byte login A JSON + 109-byte login B JSON + 256-byte REST upload. GETs have zero request-body bytes. Charged bytes are intended transmitted request bodies, not response/header bytes or physical Storage usage. Counters are durable and unrefunded. Failed cross-read consumes no allocation/body bytes. No counters or prefix were reset.

**One REST object at A00 was created and then read with exact fixture validation**, evidenced by upload/download HTTP 200. It is intentionally left in place; no separate post-run object catalog read was performed. Persisted provider owner_id was not reached/observed. The actor/path alone is not recorded as ownership proof. Ledger cleanup preview is empty because owner verification remains pending; this does not mean no object exists or no eventual cleanup is needed.

**No TUS resource was created by this run.** Known TUS resource list/incomplete count are zero. Creation, HEAD offsets, exact 6 MiB PATCH/final tail and completion are all untested. No claim about unrelated provider-side incomplete resources is made. No objects/accounts/bucket/policies were deleted or modified beyond the single approved REST object creation.

## Stop, evidence and remaining approvals

Encrypted external ledger and existing approval are retained. CLI exit code 1; durable halted reason DENIAL_NOT_ESTABLISHED. The process lock was released normally and read-back succeeded; no lock clearing/recovery/reset was performed. A halted ledger must not be replayed or replaced to spend unused capacity. Approval is not renewed by this report and expires at its unchanged time.

First-wave security acceptance is incomplete: A owner-path read worked and both ordinary identities verified, but cross-user denial is unverified and wrong-owner/anonymous probes were never reached. No successful unauthorized access was observed. TUS/owner/quota/security compatibility remains unresolved; ADR-041 remains a release blocker.

Separate authorization is required for diagnostic/ledger reconciliation before any further provider scenario; separate read-only owner-evidence authorization is needed before cleanup eligibility, and explicit owner cleanup approval is required before deleting A00. No cleanup is performed here. Do not resume the CLI, replace approval, reset budgets, use reserved whole-run capacity, start Task 1.5 or Phase 2.

No production/runner source or dependencies changed. Previously executed local runner/native safeguards remain documented in prior reports; no new application regression suite is claimed in this resumption. Current checks are fresh read-only prerequisites, existing approval/ACL/scope/expiry, zero-ledger initialization, actual CLI outcome and durable read-back, documentation formatting/preservation/link checks. Raw fixture digest and private capability/session values are intentionally omitted.
