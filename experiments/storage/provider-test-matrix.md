# Bounded provider first wave — preparation only

Task 1.4B.0 prepares this matrix; no provider requests are authorized or executed. Historical Task 1.4A.7 verified the development resources. Refresh read-only prerequisites before a future approved run. Production behavior and ADR-041 remain unresolved.

Target: `mdyiczsuddpqgjtfofgs`, private `smart-storage-feasibility`, 8,388,608-byte object limit, MIME `application/octet-stream`. Immutable run: `p14b-20261011-c40e8e03/`. Exact paths in [manifest.ts](provider-runner/manifest.ts) match the deployed SQL: A UUID `7aaa8834-54ec-4f57-ae96-080928d8f74f` slots 00–05, B UUID `4af63360-f59f-48d7-a745-49cb4339f26a` slots 06–11; path is run/UUID/two-digit-slot.raw. No other path is permitted.

## Sequential request matrix

| Request ID           | Actor     | Method | Slot    | Allocation attempts | Maximum body bytes | Required observation                                             |
| -------------------- | --------- | ------ | ------- | ------------------- | ------------------ | ---------------------------------------------------------------- |
| login-A              | A         | POST   | none    | 0                   | 16,384             | Ordinary authenticated JWT; private storage                      |
| identity-A           | A         | GET    | none    | 0                   | 0                  | Exact UUID/email, nonanonymous authenticated user                |
| login-B              | B         | POST   | none    | 0                   | 16,384             | Distinct ordinary authenticated JWT                              |
| identity-B           | B         | GET    | none    | 0                   | 0                  | Exact UUID/email, nonanonymous authenticated user                |
| rest-A               | A         | POST   | A00     | 1                   | 256                | 200/201, no upsert                                               |
| download-A           | A         | GET    | A00     | 0                   | 0                  | 256 bytes, exact deterministic fixture digest                    |
| cross-read-B         | B         | GET    | A00     | 0                   | 0                  | 401/403/404; any success stops run                               |
| wrong-owner-B        | B         | POST   | A01     | 1                   | 32                 | 401/403/404; any success stops run                               |
| anonymous-read       | anonymous | GET    | A00     | 0                   | 0                  | 401/403/404, no user bearer                                      |
| tus-create-A         | A         | POST   | A02     | 1                   | 0                  | 201, bounded private Location, declared length 6,292,480         |
| tus-head-zero        | A         | HEAD   | A02     | 0                   | 0                  | Offset 0, exact declared length                                  |
| tus-part-first       | A         | PATCH  | A02     | 0                   | 6,291,456          | 204, acknowledged offset 6,291,456                               |
| tus-head-recovery    | A         | HEAD   | A02     | 0                   | 0                  | Same offset/resource after acknowledged first part               |
| tus-part-tail        | A         | PATCH  | A02     | 0                   | 1,024              | 204, offset 6,292,480                                            |
| tus-head-complete    | A         | HEAD   | A02     | 0                   | 0                  | Final offset equals declared length                              |
| owner-info-rest      | A         | GET    | A00     | 0                   | 0                  | Provider owner_id if exposed; otherwise pending catalog evidence |
| owner-info-tus       | A         | GET    | A02     | 0                   | 0                  | Same owner verification requirement                              |
| Future owner cleanup | A         | DELETE | A00/A02 | 0                   | 0                  | Separate approval and ledger eligibility; CLI preview only       |

Three distinct allocation targets use A00/A01/A02. Download, denial reads and TUS continuation necessarily refer to their existing fixture/resource; they do not need additional allocation slots. Wrong-path means B targets an approved A-only path; an unknown prefix is rejected locally and never sent. Nine slots and nine allocation attempts remain reserved, not authorized for execution. This first wave does not test B writes or ambiguous-response replay.

Worst-case first-wave attempted bodies: **6,325,536 bytes**, including both capped Auth bodies and the denied 32-byte POST. Remaining aggregate capacity: **27,228,896 bytes**. Counters charge actual intended bodies before transmission, including failures and ambiguous results, never refund them, and exclude headers/response bytes. TUS POST counts one allocation; PATCH bodies count bytes. Every repeated allocation would count again, but duplicate stage IDs and automatic retries are prohibited. Hard whole-run ceilings remain **12 attempts / 33,554,432 bytes** across process restarts. Nine unused attempts are not permission to bypass this fixed stage manifest.

## Evidence and stop conditions

Owner metadata absent from the ordinary info response remains unresolved. A separately approved read-only catalog audit can supply exact path/owner records through the local owner-evidence mode; this is labeled user-supplied catalog evidence, not an automated provider verification. No owner evidence means no cleanup eligibility. TUS final offset is protocol completion evidence, not independent physical storage/digest verification.

The [official resumable guide](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) specifies 6 MiB chunks and direct Storage hostname. This runner uses no upsert, redirects, automatic retry, signing, refresh or privileged fallback. Its strict Location decoding is a fail-closed assumption about the deployed provider format, not a verified runtime contract. HEAD after an acknowledged part tests offset recovery only; dropped responses, cross-user HEAD, JWT expiry, concurrent resources, exact reservation enforcement and temporary-byte cleanup require separately reviewed experiments. No capacity/abuse probes are included here. ADR-041 remains a release blocker.

Unexpected write/success, malformed denial, unknown Location, incorrect identity/offset/digest, budget exhaustion or ambiguity stops further requests. Retain the encrypted resource reference for reconciliation. Never remove a stale lock, reset counters, rotate the prefix or replay with curl to recover. Review private ledger plus read-only provider evidence before proposing any authorized recovery.

## Approval before any provider request

Explicitly authorize this exact development first wave, including **two Auth password sign-ins and identity GETs**, REST upload/download and denial probes, one TUS creation/HEAD/PATCH completion and owner-info GETs, bounded to this run and these counters. Cleanup, signing, expiry, refresh, concurrency and quota probes remain excluded. Review current project health, exact bucket/identities/policies and empty namespace first. Then create a private, expiring manifest-bound approval record and confirm its opaque ID; no approved record exists in the repository.

Execution approval never authorizes deletion. Future cleanup requires a separate exact ledger-bound owner-deletion approval and review of incomplete-resource reconciliation. No bucket-wide sweep, unrecorded object, test-account, bucket or policy deletion is permitted.
