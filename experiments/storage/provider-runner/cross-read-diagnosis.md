# Task 1.4B.2B — cross-user HTTP 400 diagnosis

Completion: **ROOT CAUSE IDENTIFIED**. Finding: **EXPECTED PROVIDER DENIAL** for the recorded B-to-A00 request, with an independently observed NoSuchKey error. This diagnoses the retained request; it does not resume the first wave or certify other security scenarios.

## Exact sanitized error and correlation

[Provider evidence](cross-read-provider-diagnosis.json) records filtered log fields only, without tokens, sessions, request headers, client addresses, raw error payloads or private URLs.

| Field                  | Observed provider value             |
| ---------------------- | ----------------------------------- |
| Outer HTTP status      | 400                                 |
| Storage error code     | NoSuchKey                           |
| Logical error status   | 404                                 |
| Sanitized message      | Object not found                    |
| Acting identity        | User B, ordinary authenticated role |
| Storage operation      | object.get_authenticated_info       |
| Storage appVersion     | 1.80.2                              |
| Storage log time       | 2026-10-12T15:49:58.826Z            |
| Edge download log time | 2026-10-12T15:49:58.696Z            |

An exact-A00 path/time filtered edge log shows B's authenticated download GET returned 400; Storage logged the related authenticated metadata lookup for B with NoSuchKey/404 and the fixed message above. Owner A's prior download/metadata logs show 200. No new download, sign-in or replay was issued to obtain these records. Correlation uses exact target, actor, method, status, sequence and close timestamps; the original runner did not retain a request-ID trace join. A byte-for-byte client error body is unavailable because the adapter consumed it without parsing/persisting failure details.

Original local report timestamps are skewed relative to provider timestamps: initial 15:44:30–15:47:30Z log search returned only pgbouncer rows. Current object's provider creation timestamp 15:49:39Z guided a distinct targeted 15:48:30–15:52:30Z window, which returned the relevant Storage/edge records. Do not treat local/provider wall clocks as synchronized or mark the later object timestamp as evidence of a replay. No replay occurred in this task.

## Confirmed resource and policies

Read-only SELECT confirmed exact A00 exists with size 256 and MIME application/octet-stream. Its owner_id is **7aaa8834-54ec-4f57-ae96-080928d8f74f**, matching approved User A. Bucket remains private with exact 8388608 limit and octet-stream restriction. The complete four-policy catalog is byte-identical to the verified pre-execution baseline; no extra Storage policies. Ownership evidence is retained in this diagnostic file only, not written into the experiment ledger or cleanup state.

Native MCP execute_sql/query_logs calls failed with **OAuth token refresh failed: Failed to parse server response**. The separately connected Supabase connector succeeded for explicitly scoped SELECT/log queries. Its SQL role is postgres and transaction_read_only off; this is privileged metadata inspection performed read-only, not proof of ordinary-user access, and not a service-role fallback in the test runner. No SQL writes/settings/policy changes were issued. No repeated authentication was requested.

## Why HTTP 400 occurred

The [official Storage error documentation](https://supabase.com/docs/guides/storage/debugging/error-codes) explains that NoSuchKey can indicate an absent object or lack of permission to access an existing one. HTTP status alone is therefore insufficient, and 400 can also mean malformed requests. The observed code/message and existing A-owned object distinguish this case from a generic malformed request.

The [version 1.80.2 authenticated metadata route](https://raw.githubusercontent.com/supabase/storage/v1.80.2/src/http/routes/object/getObjectInfo.ts) performs private-bucket object lookup in caller context; only public access uses the elevated lookup. The [same version's error handler](https://raw.githubusercontent.com/supabase/storage/v1.80.2/src/http/error-handler.ts) can emit outer HTTP 400 for a renderable non-500 error while preserving its logical status and code in the response. These tagged sources match the logged appVersion, avoiding reliance solely on current master.

The request reached Storage as authenticated B and failed during the private metadata/object lookup, not a client parameter-validation error. The B identity/path/owner restrictions in the unchanged SELECT policy exclude A00. **Inference from logs plus tagged route and catalog evidence:** RLS-filtered visibility produced NoSuchKey, then the error handler surfaced it as outer 400. A per-query PostgreSQL RLS execution trace was not retrieved, so individual policy evaluation is not directly traced. The full CDN/internal-routing sequence is not separately proven; observed metadata lookup and outer download logs are sufficient for the error classification. No evidence of successful unauthorized content access was found.

## Implementation finding and minimal proposal

Owner download and cross-read use the same exact authenticated GET endpoint/path; B uses its independently verified ordinary bearer, fixed publishable key and zero body. There is no signing, malformed path substitution, retry or redirect. The adapter currently parses JSON only for successful login/identity/owner-info; cross-read error bytes are bounded and consumed but error code/logical status/message are discarded. Runner accepts only 401/403/404 for expected denial; 400 consequently caused the correct fail-closed stop.

**Recommend, do not implement here:** retain a bounded, strictly validated error envelope on non-success responses, persisting only allowlisted code, normalized logical status and a fixed sanitized message category. Add one narrow classifier exception only when all these conditions hold:

- Exact reviewed cross-read-B context: B ordinary verified identity, authenticated GET of approved A00, known existing A-owned object in the private feasibility bucket.
- Outer status 400; validated code exactly NoSuchKey; logical status exactly 404; message matches the fixed Object not found category.
- No successful content response or unexpected write; envelope parsing is bounded and no raw URL/credential/header data is persisted.

Reject all other 400s, including InvalidRequest/InvalidJWT, missing or malformed code/status, wrong actor/path/context and unknown envelopes. Do not use message-only matching, status-only matching or a general HTTP-400 allowance. The current stop condition remains installed until a separately approved local correction and tests are reviewed. No runner/application source changed in this task.

## Ledger inspection limitation and reconciliation

Attempted the supported Ledger.load inspection under its existing lock/API, with directory validation first. It stopped before acquiring/loading at PRIVATE_STORE_FAILURE: the canonical directory now has three explicit Allow entries (Admin/SYSTEM FullControl plus CodexSandboxUsers ReadAndExecute/Synchronize), not the required two. Read-only ACL metadata identified the extra group SID ending 1002. Its origin is unverified. No ACL repair or validator bypass was attempted; no tokens/credentials were decrypted in this task. Fresh encrypted-journal verification is consequently incomplete. The prior durable redacted results remain available and unchanged; the failed inspection did not update the ledger or budgets.

The recorded stage can be **conditionally reconciled without replay** using this independently obtained provider denial evidence, preserving its original HTTP 400 and every counter. Before doing so, separately authorize restoration of the ledger directory's private ACL and renewed integrity verification, then a reviewed append-only reconciliation that retains the original failure/history and attaches evidence. Do not clear halted state, alter an entry, delete a lock, reset/rewrite counters or resume the CLI under this diagnosis task. The existing ledger schema has no dedicated reconciliation-event operation; the procedure requires explicit review, not an ad hoc edit.

## Accounting, approvals and verification

Counters remain **1 allocation / 474 attempted body bytes consumed**, based on preserved durable execution evidence and zero subsequent test requests. Strict first-wave remainder **2 / 6,325,062**. Whole-run remainder 11 / 33,553,958 remains unapproved additional capacity. A00 remains; no TUS resource or cleanup was created/performed by this task.

Executed: local evidence/source inspection, read-only catalog/policy comparisons, bounded aggregate/log-field discovery and filtered event correlation, attempted supported ledger inspection plus read-only ACL diagnosis, official documentation/tagged-source review, artifact formatting/preservation/link checks. No new unit/build/browser test run is claimed; no code changed. Diagnostic metadata is stored separately; original execution/approval/ledger artifacts are not replaced or modified.

Required approvals before further live work: local ledger ACL/integrity reconciliation, narrowly scoped classifier/error-envelope change plus tests, explicit no-replay stage reconciliation, and a separately approved execution plan/valid approval if later stages should run. Cleanup requires its own explicit permission; diagnostic ownership evidence does not authorize deletion or make the halted ledger eligible automatically. Native MCP authentication remains a separate connection issue, with the exact OAuth refresh blocker recorded above. Stop after diagnosis; Task 1.5/Phase 2 unstarted; ADR-041 remains unresolved.
