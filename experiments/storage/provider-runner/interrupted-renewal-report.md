# Interrupted second-renewal investigation — 2026-10-13

Classification: **BLOCKED — AMBIGUOUS AUTH REQUEST**, pending the redacted durable-history diagnostic. No real ledger, credential store or approval was accessed. No live Auth/Storage requests, approval creation, recovery, cleanup or later phase occurred. ADR-041 remains unresolved.

## Meaning of the stop code

In `renewSessions`, `SESSION_RENEWAL_INTERRUPTED` is thrown only after `transport.send` throws, the ledger reload succeeds, and an `ambiguous` event is successfully appended. The underlying exception is discarded. The native adapter performs approval, ACL, request, checkpoint and reservation checks before dispatch; records `dispatched` before a further approval/ACL check and before `fetch`; then fetches and reads/parses a bounded response. Any exception in that adapter can therefore produce the same interruption code, including local pre-dispatch failures, timeout/network failure or invalid/truncated JSON after receiving an HTTP response. It is not proof of a network error or a successful login.

The user's inspection reports 1 allocation, 474 stage bytes, 327 renewal bytes, 801 total bytes and zero Storage continuation requests. Compared with the earlier 218 renewal bytes, 109 bytes were additionally reserved. This establishes attempted-body accounting only. The interrupted operation may be A login or its subsequent zero-body identity check; counters cannot distinguish them. A successful login alone does not replace session A; exact independent identity verification is required. Expired current sessions do not establish whether a new token was received.

`continuationBlocked: false` in the existing summary describes the Storage halt/reconciliation flag, not renewal completion or session readiness. The new diagnostic explicitly reports the renewal execution and Storage-by-renewal blockers.

## Durable evidence matrix

| Outcome                                  | What the existing journal establishes                                                                | Limit                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reserved, no dispatch marker             | Reservation and any later ambiguous transition are retained                                          | With this native adapter and intact history, no fetch was entered for that reservation. It is still terminal; no automatic replay or reconciliation is authorized.                         |
| Dispatch marker, no completed response   | Dispatch intention was durably committed before fetch                                                | Cannot distinguish pre-fetch local failure, delivery, timeout, or response-reading failure. Never replay.                                                                                  |
| Response received, not durably committed | No dedicated received-response record exists                                                         | An HTTP response lost during parsing/commit may look identical to network ambiguity. Incomplete journal/snapshot/pending state stops integrity validation; nothing is cleared or repaired. |
| Completed request, then local failure    | Completed response/status/token and identity proof, where applicable, remain in earlier journal rows | A committed login is not a verified identity. It does not authorize another request or Storage by itself.                                                                                  |

The implementation correction reloads the ledger before recording a verification/commit failure. Incomplete commits now stop without a further append; fully committed responses are not relabeled failed and produce `SESSION_RENEWAL_POST_COMMIT_STOP`. This protects future handling without altering or repairing existing evidence. No response-observed schema was retroactively invented.

## Terminal input

Auth confirmation is accepted only by exact string equality before a private approval is created. Unexpected text rejects confirmation; closing the prompt before authorization prevents requests. After authorization, stdin is not used to construct Auth bodies, tokens, approvals or fetch requests. Later text cannot change the approval ID or target. Interrupt/termination can interrupt the process, but no terminal transcript or journal evidence was inspected here; there is no basis to attribute the actual failure to input. Fixture tests cover unexpected confirmation and a closed question without any approval creation or state mutation.

## Exact normal-Windows read-only diagnostic

Use normal PowerShell as the same Admin account, outside VS Code/Codex:

```powershell
Set-Location 'C:\Users\Admin\Desktop\NEW\smart-storage'
node .cache/provider-runner/build/continuation-helper-cli.js --diagnose-renewal
```

No additional execution authorization is required for this local diagnostic. It validates existing ACLs, takes its own process lock, loads encrypted journal/snapshot integrity and validates session transitions and checkpoint references. It prints only project/run/manifest, event index/round/actor/operation/reservation time, byte count, state/status, durable dispatch/completion/identity markers and transition generations. It does not print tokens, credentials, approval IDs, private resource URLs or checkpoint digests. No configuration/key/credential-store/approval read or provider request is needed. Marker, journal and snapshot are unchanged; only its own temporary lock is released normally. An existing lock, pending commit or integrity failure causes a stop without clearing evidence.

The returned `providerRequests: 0` describes the diagnostic invocation, not proof that the historical request was never sent. `dispatchMarkerObserved` describes intention, not delivery. The command never reconciles or resumes.

## Evidence required and authorization boundary

Provide the redacted diagnostic output, particularly the last renewal event and its transition sequence. A reserved-to-ambiguous history without dispatch would support investigation of a local failure and a separately designed/authorized non-replay recovery. A dispatch marker requires correlated existing Auth/provider evidence (exact identity, endpoint, timestamp, status/request correlation where available) and any privately retained verified response; a provider success log alone cannot recreate a lost JWT or establish the required independent identity verification. Missing evidence must remain missing.

No safe reconciliation or third renewal is implemented. Any later recovery needs explicit authorization after evidence review; dispatched/ambiguous requests may not be replayed, original counters/history may not be reset, and the 30-minute session-lifetime gate remains intact. With reported zero Storage progress, the unchanged Storage allowance remains two additional allocations/6,292,512 stage-body bytes, subject to the preserved cumulative Auth/Storage cap. There is no presently safe execution procedure to promise.

## Tests

Disposable fixtures reproduce native pre-dispatch failure, post-dispatch fetch failure, HTTP 200 malformed response, successful native second-round dispatch/commit, completion commit interruption, completed response followed by local failure, and unexpected/closed confirmation. Read-only projections are checked for unchanged encrypted journal bytes and secret suppression. Native Windows tests exercise DPAPI, strict ACLs, locks and the compiled diagnostic with a disposable USERPROFILE. Final executed check counts are recorded in progress; no real state or provider evidence was inspected.

User-reported remaining session lifetimes were A -1271 seconds and B -1092 seconds. Both remain expired; no local claim decoding was performed on real tokens. With reported renewal consumption 327, cumulative renewal headroom is 32,223 bytes; this is accounting capacity, not permission for more Auth requests. No additional Auth execution is authorized by this investigation.

Final interruption investigation checks: 109 runner tests passed in a standalone rerun, 8 disposable native Windows tests passed, runner TypeScript compilation and application typecheck passed, ESLint and formatting passed. The earlier concurrent runner invocation had one 5-second timeout in an existing mocked TUS test (108 passed); it passed on the standalone rerun without changing its timeout or assertions. New fixtures distinguish reservation/dispatch history, demonstrate missing response-received evidence, preserve completed responses and stop on incomplete commits. No real state or provider requests. Classification remains BLOCKED — AMBIGUOUS AUTH REQUEST until normal-Windows diagnostic evidence is supplied.
