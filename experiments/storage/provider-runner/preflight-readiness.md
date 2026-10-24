# Task 1.4B.1 — execution readiness

Classification: **READY FOR EXPLICIT AUTHORIZATION**. This is readiness for the bounded development experiment, not approval to execute or certification of provider behavior. No execution approval file was created, the CLI was not executed in this task, actual test credentials were not decrypted, and the real ledger remains absent. Only read-only MCP/provider metadata and official documentation were accessed remotely.

## Refreshed prerequisites

[Provider evidence](preflight.remote.json) observed 2026-10-12T15:16:02.220444Z: target `mdyiczsuddpqgjtfofgs` reports ACTIVE_HEALTHY; connected URL matches. Development-only isolation remains user-confirmed. MCP SQL is `supabase_read_only_user`, transaction_read_only on. Bucket ID/name `smart-storage-feasibility` is private, limit exactly 8,388,608, MIME exactly application/octet-stream. Both approved UUID/email pairs are confirmed, ordinary authenticated, nonanonymous accounts. Prefix and entire named feasibility bucket each contain zero objects (counts only).

Exactly four policies exist, all on storage.objects, with zero unexpected policies and none on buckets. Commands/roles/modes/USING/WITH CHECK strings exactly match the independently verified Task 1.4A.7 catalog evidence, which was AST-compared against the approved deployment SQL. No expression normalization was needed for this refresh. Storage objects/buckets remain owned by supabase_storage_admin, RLS enabled/not forced. No remote mutation, test-user authentication, object/TUS request or cleanup was performed. Empty persistent object metadata does not prove no incomplete provider-side TUS resources exist; no prior upload run is recorded.

## Actual implementation review

| Safeguard                 | Implementation and result                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact project/bucket      | manifest constants, assertProject rejects nonexact URL, fixed Auth/Storage hosts and bucket endpoint/metadata; approval binds both                                                                                                                     |
| Twelve paths/identity     | Generated exact six-per-user paths match deployed SQL; validateIntent pins stage actor/method/path/expectation; only explicitly named denial probes cross ownership                                                                                    |
| Whole-run 12 / 33,554,432 | Ledger reserve checks counters before body transmission, no refund; load reconstructs from encrypted entries; journal/snapshot/marker retain state across restart                                                                                      |
| First-wave 3 / 6,325,536  | Exactly 17 unique stage IDs, each allowed once; only rest-A, wrong-owner-B, tus-create-A allocate; per-stage body caps sum to 6,325,536. Fixed stage allowlist plus duplicate rejection enforces the smaller wave without resetting whole-run ceilings |
| Login bodies              | JSON email/password encoded to Buffer; actual UTF-8 byteLength is charged before Auth HTTP, each capped at 16,384; never credentials-as-headers-only accounting                                                                                        |
| No retries/redirects      | Exactly one fetch per intent, redirect:error, 30-second timeout; no refresh, automatic replay or alternative endpoint                                                                                                                                  |
| Sequential                | Runner busy guard plus whole-process exclusive wx lock; native subprocess contention tested                                                                                                                                                            |
| Durable state             | Journal append and fsync, pending snapshot write/fsync and atomic rename; partial journal or inconsistent snapshot fails closed. The journal itself is not an atomic append guarantee: partial writes are detected and block further execution         |
| Approval                  | Expiring exact project/bucket/run/manifest record plus matching opaque confirmation ID; per-purpose checks before every request in Runner and ProviderHttp; execution approval cannot authorize deletion                                               |
| Ordinary users only       | Only publishable key accepted; ordinary JWT role/subject filter plus Auth user identity verification; no service-role read/fallback                                                                                                                    |
| Redaction                 | Public summary shows actor/slot/status/counters; JWTs/credentials/private Locations are encrypted externally; raw errors are replaced by bounded codes                                                                                                 |
| Ambiguity                 | Reservation remains charged; transport failure persists ambiguity and halt; crash/partial commit stops on reload. No stale-lock removal or automatic recovery                                                                                          |

Native adapter rechecks the durable reservation before fetch. One defect identified during review: this check did not compare the stored allocation flag with the manifest-derived classification. It now does, preventing a direct adapter caller from supplying a read-classified reservation for an allocating POST. Ordinary CLI already passed the correct flag. Another hardening makes exact TUS part length and offset mandatory, rejecting short non-final chunks locally. Neither change alters the matrix, paths, identities, total payload, manifest hash or approved SQL.

## TUS compatibility and exact first wave

The [Supabase guide](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) requires the 6 MiB chunk setting. The first PATCH is already **6,291,456 bytes at offset 0**, followed by **1,024 final bytes at offset 6,291,456**, total **6,292,480**. No smaller non-final PATCH is proposed. The HTTP adapter sends Buffer bodies, Tus-Resumable 1.0.0, Upload-Offset and application/offset+octet-stream; mocked HTTP verifies the exact body and headers. Upload-Length is sent only at creation. Node fetch derives body length from the Buffer. Final short tail completes the declared length; actual deployed acceptance remains to be observed, not assumed from the generic protocol. [TUS protocol](https://tus.io/protocols/resumable-upload) defines zero-body creation, HEAD length/offset and PATCH acknowledgments. No sequence correction is required.

| Order | Request                | Actor     | Slot | Body ceiling | Allocation |
| ----- | ---------------------- | --------- | ---- | ------------ | ---------- |
| 1     | login-A POST           | A         | none | 16,384       | 0          |
| 2     | identity-A GET         | A         | none | 0            | 0          |
| 3     | login-B POST           | B         | none | 16,384       | 0          |
| 4     | identity-B GET         | B         | none | 0            | 0          |
| 5     | rest-A POST            | A         | A00  | 256          | 1          |
| 6     | download-A GET         | A         | A00  | 0            | 0          |
| 7     | cross-read-B GET       | B         | A00  | 0            | 0          |
| 8     | wrong-owner-B POST     | B         | A01  | 32           | 1          |
| 9     | anonymous-read GET     | anonymous | A00  | 0            | 0          |
| 10    | tus-create-A POST      | A         | A02  | 0            | 1          |
| 11    | tus-head-zero HEAD     | A         | A02  | 0            | 0          |
| 12    | tus-part-first PATCH   | A         | A02  | 6,291,456    | 0          |
| 13    | tus-head-recovery HEAD | A         | A02  | 0            | 0          |
| 14    | tus-part-tail PATCH    | A         | A02  | 1,024        | 0          |
| 15    | tus-head-complete HEAD | A         | A02  | 0            | 0          |
| 16    | owner-info-rest GET    | A         | A00  | 0            | 0          |
| 17    | owner-info-tus GET     | A         | A02  | 0            | 0          |

Worst-case wave: **three allocation attempts, 6,325,536 attempted body bytes** including denied writes and Auth bodies. Nine attempts / 27,228,896 bytes remain reserved, not authorized for other experiments. Cleanup is excluded. Exact methods/paths and expected observations are in the [matrix](../provider-test-matrix.md).

## Windows evidence and local verification

Four native integration tests use a unique temporary USERPROFILE override and fake disposable credentials. They verify DPAPI Unicode roundtrip/corrupt-cipher rejection, current-SID/SYSTEM ACLs inherited by files, rejection of an Everyone-readable file, ProtectedCredentials interface and exact approved identity matching with fake passwords, local ledger initialization/reinitialization refusal, encrypted journal/snapshot persistence with a charged allocation, restart counters and a second-process lock conflict. After tests, only verified temporary fixtures are removed; the real profile/ledger/credential store are untouched. The real ledger is independently observed absent.

Initial sandbox native tests failed because DPAPI reported unavailable current-user profile under its restricted context. Disposable-only tests passed in the normal Windows user context; the final native suite has four passing tests. Production invocation must use that loaded user context and pass ACL/DPAPI checks; no fallback encryption or relaxed ACLs is permitted. Physical power-loss durability, malicious same-user rollback, disk failure and actual credential-content verification remain outside this evidence.

| Executed check                      | Result                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| npm.cmd run typecheck               | Passed                                                                                 |
| npm.cmd run lint                    | Passed, zero warnings                                                                  |
| Runner TypeScript compilation       | Passed; CLI not executed                                                               |
| Runner suite in normal user context | 37 passed before final HTTP test; includes 33 mocked and four native tests             |
| Final runner.test.ts only           | 34 mocked tests passed, including exact first-PATCH HTTP body/headers                  |
| npm.cmd test                        | Six application tests passed; existing Boxicons missing-source-map warnings            |
| Existing Storage Vitest suite       | 15 model tests passed                                                                  |
| Formatting                          | Passed after targeted formatting                                                       |
| Config audit / preservation         | No exposed credential values; five SQL/dependency hashes unchanged; real ledger absent |

Total current coverage: **59 passing tests** (34 mocked runner + four native + six application + 15 Storage model). No single 59-test combined command is claimed. Build/browser checks were not repeated because production code and dependencies are unchanged.

## Remaining uncertainties and approval boundary

Runtime policy/helper/owner/TUS completion behavior is unverified. Strict TUS Location decoding could fail closed on a different deployed format. HEAD recovery here follows an acknowledged part, not an ambiguous response or cross-user isolation test. A 200-only HEAD expectation is deliberately narrow; a valid alternative 204 would stop for review, not silently broaden acceptance. Ordinary object-info may omit owner_id, requiring separately obtained read-only catalog evidence before cleanup eligibility. Final TUS offset does not establish physical object integrity or cleanup. ADR-041 exact reserved-byte/concurrent/temp-resource enforcement remains a release blocker; the local experiment ledger does not implement production quota enforcement.

Before any provider request: explicitly authorize these 17 requests, including two Auth sign-ins, target/run/caps and fail-closed stop conditions; then prepare the expiring private manifest-bound approval record in the verified Windows user context. No active approval record exists. Cleanup, signing, refresh/expiry, ambiguous replay, concurrency and quota probes are excluded and require separate approval. Recheck prerequisites if resource state changes or execution is delayed. Stop after this report; no Task 1.5 or Phase 2 work.
