# Task 1.4B.2 — controlled first-wave outcome

Classification: **FIRST WAVE STOPPED / INCOMPLETE**.

The user authorized only the reviewed 17-stage development first wave, three allocation attempts and 6,325,536 aggregate attempted body bytes. Whole-run capacity was not treated as additional permission. The existing CLI was invoked only through a preparation wrapper; execution stopped at private approval-file ACL validation, before ledger initialization or any Auth/Storage request. No retry, replacement approval, ACL repair, provider mutation or cleanup followed.

## Fresh prerequisites and local readiness

[Fresh read-only provider evidence](first-wave-preflight.json), observed 2026-10-12T15:34:51.232814Z, matches Task 1.4B.1 bucket, identities and complete policy catalog fields exactly. Connected URL/project reference match mdyiczsuddpqgjtfofgs; project reports ACTIVE_HEALTHY. Exact feasibility bucket remains private, 8388608 bytes, MIME application/octet-stream. Both approved accounts are ordinary authenticated, confirmed and nonanonymous. Exactly four expected unchanged Storage policies; zero unexpected policies; prefix and named bucket object counts zero. Native MCP SQL is supabase_read_only_user with transaction_read_only on. Development isolation remains user-confirmed.

Runner TypeScript compilation passed. Compiled manifest matches the reviewed hash, seventeen stages, twelve paths, exact 6291456-byte non-final PATCH and 1024-byte final tail, and 6325536-byte first-wave maximum. No prior canonical run ledger existed. Four disposable native Windows tests passed (29.06 seconds), verifying DPAPI/ACLs/credential interface/ledger/process locking. Private retrieval of both actual approved accounts succeeded in normal user context, without exposing their credentials; distinct passwords were verified. This credential retrieval performed no Auth sign-in.

## Exact stop and supporting evidence

A single private approval candidate was written to the existing external credential directory, with an unpredictable confirmation ID, exact manifest/target/purposes and expiry exactly thirty minutes after creation. Its post-write privateFile check rejected inherited permissions and raised PRIVATE_STORE_FAILURE. The candidate remains retained externally; its ID/content are not included here. It was never passed to an executing CLI and must not be reused or replaced automatically.

Subsequent read-only ACL metadata established:

| Local item                               | Observed ACL / state                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Existing credential file completed.dpapi | Two explicit Allow entries: current Windows user and SYSTEM, FullControl                                       |
| Parent credential directory              | Three explicit Allow entries: current user, SYSTEM and an additional principal with ReadAndExecute/Synchronize |
| New approval candidate                   | Three inherited Allow entries: current user, SYSTEM and the additional ReadAndExecute/Synchronize principal    |
| Canonical run ledger                     | Absent; initialization never reached                                                                           |

The adapter requires exactly current-user/SYSTEM Allow entries. The additional inherited principal is the confirmed immediate blocker; its origin was not independently established. No privilege relaxation or ACL change was attempted. The existing credential file remains independently restricted; this evidence does not establish password exposure. Local metadata inspection after the stop did not decrypt credentials or contact the provider.

## Provider-stage evidence

| Stage IDs in approved order                                                                      | Actual result                |
| ------------------------------------------------------------------------------------------------ | ---------------------------- |
| login-A; identity-A; login-B; identity-B                                                         | Not executed; no HTTP status |
| rest-A; download-A; cross-read-B; wrong-owner-B; anonymous-read                                  | Not executed; no HTTP status |
| tus-create-A; tus-head-zero; tus-part-first; tus-head-recovery; tus-part-tail; tus-head-complete | Not executed; no HTTP status |
| owner-info-rest; owner-info-tus                                                                  | Not executed; no HTTP status |

Last executed provider stage: **none**. This run created no remote objects or TUS resources. REST fixture digest verification, denial behavior, provider ownership and TUS offset/completion remain **not tested**. No new ownership evidence was queried or recorded. No experiment ledger exists, so there are no ledger cleanup candidates. The preflight's zero persistent object count cannot certify absence of unrelated incomplete provider-side resources, but this attempt created none.

Budget consumed: **0 allocation attempts / 0 attempted provider request-body bytes**. First-wave allowance remaining: **3 / 6,325,536**; whole-run remaining: **12 / 33,554,432**, with additional whole-run capacity still unapproved. No counters were reset; none were initialized or spent. Failed local ACL validation consumes no remote allocation/body budget.

## Required next action and checks

Stop as instructed. A separately authorized local private-store ACL/approval reconciliation is required before any execution attempt can resume; review the retained candidate instead of creating a replacement. Preserve evidence and do not silently reuse its confirmation or extend expiry. Any later live execution requires renewed explicit approval after the blocker is resolved. No owner-evidence or cleanup work is needed for objects from this stopped attempt; separate owner-evidence/cleanup approvals would be required only for a later executed wave.

Local verification: TypeScript compilation, four native disposable tests, exact manifest/remote-baseline comparison, credential retrieval without logging, local ACL/existence inspection, formatting and artifact preservation/link checks. No production application or runner source changes were made. No RLS/bucket/account/global setting changes, signing, quota/concurrency probes, deletions, cleanup, Task 1.5 or Phase 2 work occurred. ADR-041 remains a release blocker regardless of this outcome.
