# Accelerated Task 1.4B — local recovery complete

Result: **READY FOR RESUMPTION AUTHORIZATION**. Local recovery is complete; live execution is not authorized by this task. The existing approval has expired and was neither extended nor replaced. No provider requests, Auth sign-ins, uploads/TUS, cleanup, database/policy/bucket changes or new run occurred.

## ACL outcome

Confirmed CodexSandboxUsers SID ending 1002 had an explicit ReadAndExecute/Synchronize Allow ACE on the exact canonical experiment directory and inherited ACEs on marker, journal and snapshot. Safely removed it, disabled inappropriate inheritance and retained only current Admin and SYSTEM FullControl. Owners unchanged; ledger file bytes were compared unchanged during ACL correction. No lock was cleared and no artifact deleted/replaced/reset.

The known group ACE reappeared between command invocations, blocking a strict check before ledger access. Its insertion mechanism was not independently established. The successful operation performed guarded repair and strict validation/reconciliation in the same normal Windows invocation. [repair-ledger-acl.ps1](repair-ledger-acl.ps1) makes this scoped handling reviewable: exact run directory and three expected files only, known owner/principals, no links, lock, pending commit or unknown artifacts. Unexpected conditions stop before correction. Native fixture tests verify preserved contents, unchanged security validator acceptance and refusal of unknown artifacts. The validator in windows-store.ts is unchanged.

For future explicitly approved execution, perform the guarded ACL repair immediately before the existing CLI in the same normal Windows invocation; do not assume a successful check from a prior tool invocation still holds. This is not permission to repair unrelated directories or relax checks. The script is specific to this verified Windows development SID/run and is not production infrastructure.

## Classifier and sanitized error handling

[denial.ts](denial.ts) adds the exact special case: cross-read-B, ordinary B context, authenticated GET of A00, expected denial, HTTP 400, NoSuchKey, logical 404 and Object not found, with independently recorded evidence of existing A-owned A00 in the feasibility bucket. Mismatched actor/path/stage/method/status/code/message/owner/context still fails. Other HTTP 400 responses still halt.

The HTTP adapter now parses bounded non-success JSON into a small sanitized error envelope; it retains only allowlisted code, numeric logical status and a fixed message category. Raw error text, URLs, credentials, unknown code values and unrelated response fields are suppressed. Malformed/missing envelopes do not establish the special denial. Responses are durably recorded before classification; retries, redirects, privileged fallback, offset/Location checks and unexpected-success/write stops remain intact.

## Existing-ledger reconciliation

[Ledger API](ledger.ts) verifies encrypted journal/snapshot integrity and the exact seven-stage state before reconciling. Existing diagnostic evidence was checked for one matching ordinary B log, NoSuchKey/404/Object not found, Storage 1.80.2 and existing A-owned 256-byte object; no missing client-body evidence was invented. Its digest/provenance are retained privately as reference to the existing provider evidence.

One new encrypted generation appends an EXPECTED_PROVIDER_DENIAL reconciliation record. All original request entries remain byte-equivalent in serialized state, including cross-read-B status 400/state failed; every earlier journal row and marker are unchanged. The original historical halt remains recorded. Effective continuation recognizes only this validated reconciliation; no generic clear-halt operation exists. Interrupted commits/corruption fail closed, duplicate reconciliation fails and replay of an existing stage remains prohibited.

[Redacted recovery receipt](local-recovery-results.json), observed 2026-10-12T16:18:02.331Z, confirms one reconciliation, preserved history and unchanged **1 allocation / 474 attempted body bytes**. It reports continuationBlocked false while preserving the historical halt reason. No owner/cleanup eligibility entry was changed; no real credential store was decrypted. Protected ledger sessions were inspected only for verified identity/expiry metadata without exposing tokens.

## Exact continuation and budgets

The planner/CLI skip all six completed stages and the reconciled cross-read-B. Auth retrieval is not replayed for already verified sessions. Focused tests confirm no credentials.get or HTTP call for that preparation/resume-prefix check. The next stage is wrong-owner-B, followed by:

1. wrong-owner-B — A01, 32-byte denied-write probe.
2. anonymous-read — A00.
3. tus-create-A — A02, declared 6,292,480 bytes.
4. tus-head-zero.
5. tus-part-first — exactly 6,291,456 bytes at offset zero.
6. tus-head-recovery.
7. tus-part-tail — exactly 1,024 bytes at offset 6,291,456.
8. tus-head-complete.
9. owner-info-rest.
10. owner-info-tus.

Remaining strict allowance is **2 allocation attempts / 6,325,062 attempted body bytes**. These ten stages need at most **2 allocations / 6,292,512 bytes**; the unused 32,550-byte difference comes from initial Auth body ceilings and is not permission to add stages or payloads. The planner enforces the smaller three-attempt/6,325,536 whole-first-wave ceiling in addition to the existing whole-run 12/33,554,432 ceilings. No run/manifest/path changes or new prefix.

TUS binding and exact chunk/offset validation remain unchanged and tested locally: unknown Location or incorrect offsets stop and retain private evidence. Live TUS compatibility remains unverified. Other denial scenarios may still produce an unapproved HTTP 400 and stop before TUS; this task deliberately does not broaden their classifier.

## Expiry and execution gate

Existing approval scope/manifest match, but expiry **2026-10-12T16:04:01.423Z / 17:04:01.423 Africa/Lagos** has passed. It remains unchanged. A **new execution approval requires explicit user authorization**; none was created. Future execution must recheck prerequisites and session validity under separately approved scope. Stored A/B sessions were verified and valid for at least ten minutes at the receipt timestamp; that is time-bounded evidence, not a guarantee at a later execution time. If they expire, stop and obtain separately reviewed authentication/reconciliation authority, never silently repeat earlier sign-ins.

## Executed checks and changes

- 54 focused/existing runner tests passed, 12.84 seconds on final run.
- Five native Windows tests passed, 67.20 seconds; disposable ACL/DPAPI/credential/lock/repair fixtures only.
- npm.cmd run typecheck passed; runner TypeScript compilation passed.
- npm.cmd run lint passed, zero warnings. Initial root lint identified one unused import in an older ignored execution helper; removed that import only and reran.
- Formatting, preservation hashes and local links passed.
- No unrelated application/build/browser suites rerun.

Changed experimental files: new denial.ts and guarded ACL repair script; ledger.ts (audited reconciliation/continuation APIs), runner.ts (classifier/historical-vs-effective status), transport.ts (sanitized errors), cli.ts (no-replay continuation), focused runner/native tests. Recovery receipt/report and setup/progress/AGENTS documentation updated. Ignored local helpers orchestrate only the authorized repair/reconciliation; do not rerun the reconciliation helper after its one successful append.

Stop after local recovery. First wave is not completed; live requests need separate fresh authorization. No cleanup is implied. ADR-041 remains unresolved and release-blocking.
