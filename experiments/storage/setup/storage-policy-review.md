# Task 1.4A.3 — Review-only namespace, verification and cleanup

No executor; no remote test or deletion is authorized. Policy SQL is guarded and ends ROLLBACK. Account UUIDs are identifiers; credentials stay in the external DPAPI store.

## Exact namespace

Bucket: smart-storage-feasibility. Run: p14b-20261011-c40e8e03/. Six paths per identity; A uses 00.raw–05.raw, B uses 06.raw–11.raw. Full-string equality is required, not a prefix wildcard. Identity must match the designated account. Exact paths:

- A: p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/00.raw
- A: p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/01.raw
- A: p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/02.raw
- A: p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/03.raw
- A: p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/04.raw
- A: p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/05.raw
- B: p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/06.raw
- B: p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/07.raw
- B: p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/08.raw
- B: p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/09.raw
- B: p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/10.raw
- B: p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/11.raw

INSERT checks exact identity/path/bucket and operation allowlist. SELECT/DELETE additionally require persisted owner_id = auth.uid()::text. No owner check on prospective INSERT because provider permission probes may construct owner metadata differently; actual assignment must be observed later. SELECT/DELETE use the same six per-user slots as INSERT (tightened from historical draft). Restrictive UPDATE denies both old/new rows in this bucket, grants nothing elsewhere and cannot constrain RLS-bypassing administrators.

## Compatibility and future verification matrix

All rows below are **NOT EXECUTED**. Expected results are proposals, not passed provider checks. Choose an explicitly approved subset; the full matrix does not automatically fit 12 allocations/32 MiB attempted bodies. Every request-body/control/failed/retried/ambiguous allocation counts before sending. Signed/concurrency/expiry/cleanup subsets need explicit authorization. No unlimited prefix rotation or duplicate-allocation retry.

| Scenario                                                                                 | Expected result / required observation                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A and B create their six exact slots with ordinary JWT                                   | Allowed REST create/TUS subject to operation mapping; persisted owner matches creator; count allocation before sending                                                                                                    |
| A/B authenticated download, object info, listing                                         | Own exact ledger objects only; no cross-user names/content; info/list operation names must match deployed provider                                                                                                        |
| Cross-user INSERT/SELECT/DELETE/TUS HEAD/PATCH                                           | Denied even for an otherwise permitted slot; prospective and completed resources checked separately                                                                                                                       |
| Anonymous, third ordinary identity, forged owner/path                                    | Denied; path alone never authorizes identity; don't substitute service role                                                                                                                                               |
| Wrong prefix, wrong slot, nested/trailing path, swapped per-user slots, unrelated bucket | Denied by exact full-string predicate; normalization/provider canonicalization must be observed                                                                                                                           |
| UPDATE/upsert/overwrite/move                                                             | Denied on feasibility bucket; x-upsert true must not change bytes; no permissive UPDATE policy; restrictive bucket guard                                                                                                  |
| Duplicate REST/TUS create or two resources same path                                     | No replacement; record provider-specific 400/409/other denial, allocation/temporary storage and uncertain late completion; duplicates still consume attempt budget                                                        |
| Owner metadata                                                                           | Read persisted owner_id through bounded admin metadata only after authorized upload; do not claim client metadata determines owner                                                                                        |
| TUS POST, HEAD, PATCH, finalization                                                      | Distinct operation names; canUpload probes may use INSERT, not SELECT. Finalization must insert/check under part/create context; no UPDATE added to make test pass                                                        |
| Ordinary owner deletion, cross-user/anonymous deletion                                   | Owner exact-ledger delete allowed only after cleanup approval; others denied; verify physical deletion separately from metadata                                                                                           |
| Signed mint and signed consumption                                                       | Ordinary mint excluded by operation allowlist. No token is generated now. Admin-minted capabilities can bypass RLS; bearer possession differs from owner identity. Consumption/replay/revocation remains separately gated |
| Copy and S3/multipart/image alternate routes                                             | Operation names excluded; copy source/destination and move checks must fail without expanding whitelist; no alternate route quota bypass claim                                                                            |
| Cancellation, expired JWT/resource, late write, concurrent attempts                      | Unresolved release blockers; stopping client/removing policy is not proven revocation                                                                                                                                     |

Documented: private Storage is controlled by RLS; new upload uses INSERT, replacement additionally uses SELECT/UPDATE; resumable clients use POST/HEAD/PATCH and provider conflict handling. [Access control](https://supabase.com/docs/guides/storage/security/access-control), [resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).

Mutable upstream source: [operation names](https://github.com/supabase/storage/blob/master/src/http/routes/operations.ts), [TUS routes](https://github.com/supabase/storage/blob/master/src/http/routes/tus/index.ts), [TUS lifecycle](https://github.com/supabase/storage/blob/master/src/http/routes/tus/lifecycle.ts). POST is tus.upload.create; PATCH/PUT tus.upload.part; HEAD tus.upload.get; DELETE tus.upload.delete. Signed variants have _signed suffix and provider privileged contexts; they are intentionally excluded. Provider deployment/version parity and concrete INSERT/SELECT/update probes are not verified by source review. Do not call TUS HEAD a SELECT-only operation. DELETE termination of incomplete resources is NOT authorized by this object cleanup policy; review provider-specific termination separately.

Installed allow_any_operation(text[]) and allow_only_operation(text) definitions were read: exact normalized operation comparison, unknown/missing context fails closed. [Helper documentation](https://supabase.com/docs/guides/storage/schema/helper-functions). Policies allow only ordinary REST upload, ordinary TUS create/part/get probes, authenticated read/info/list and exact-owner object delete checks. SELECT includes delete operation context for APIs requiring read plus delete. Signing, copy/move, public, S3, rendering and TUS termination are excluded. An unknown deployed operation fails closed: stop and propose a reviewed adjustment instead of weakening ownership or adding UPDATE. Runtime compatibility is a provider-validation prerequisite, not certified by helper presence.

## Deployment prerequisites and rollback

1. Obtain explicit approval for the exact four policies in storage-policies.review.sql, this run, both UUIDs and development project only. Approval does not authorize tests.
2. Recheck exact bucket settings, users, all existing policies/grants, RLS ownership, API isolation and helper definitions. Stop if anything differs. Confirm fixture count zero or reconcile existing ledger; never silently drop existing policies. Review assumes no policies, and its SQL preflight aborts on any policy/second execution.
3. SQL needs an approved privileged administrative execution path; do not switch the read-only MCP connection to writable without authorization. Have qualified review/offline PostgreSQL validation first. Do not deploy just to parse syntax.
4. Make a separately reviewed execution copy removing only review guard and replacing ROLLBACK with COMMIT after approval; preserve this review artifact. Read back four policy definitions/roles/commands/predicates and ensure no unrelated changes.
5. Rollback needs approval: stop new attempts, reconcile active resources/ledger, record deployed definitions; drop only the four exact named policies in the SQL comments within a transaction. Do not remove bucket/users or alter grants. Verify remaining catalog. Policy removal is not proven revocation and may prevent owner cleanup; order needs explicit review.

## Bounded cleanup plan (not executable)

- Before the first approved allocation, create a private durable ledger with run, actor UUID, exact bucket/path, slot, attempt counter, request state, attempted bytes, observed owner/length and cleanup status. Store exact TUS resource URLs/signatures only in protected local storage; public reports use opaque references. Record ambiguous allocations even if no object appears. Multiple resources for one slot are separate attempts, not extra authorized slots.
- Validate every deletion candidate against the twelve-path allowlist, approved bucket/run, actual creating identity and ledger; reject mismatched/unknown entries. No prefix sweep, list-and-delete-all or SQL metadata DELETE. Empty ledger authorizes zero deletions.
- Only after explicit Task 1.4B cleanup approval, stop/reconcile active writers, inspect each exact recorded object, then delete through supported Storage API as the owning ordinary user. No blind delete retries or inferred success from absence in a list. Recheck exact metadata/physical provider evidence where available and record unresolved late writes.
- Incomplete TUS resources need their own ledger and lifecycle/expiry observation. Object deletion does not prove multipart/temporary-byte cleanup; no blanket termination or provider-side purge is approved. Wait/reconcile within an approved time/budget; uncertainty remains accounted for and escalated.
- Ownerless objects, unavailable owner sessions or uncertain resource ownership require a separately approved narrowly scoped privileged cleanup proposal with exact targets. Service-role bypass must never substitute for the A/B authorization matrix. No admin sweep.
- Preserve bucket and test identities; their deletion requires separate approval. Keep UUIDs/passwords private; restore any credential-store ACL drift with access-only permissions, not content changes.

ADR-041 stays Proposed/release-blocking: exact reserved bytes, concurrent reservations, temporary resource accounting, cancellation/late writes, signed-capability revocation and alternative-route quota enforcement remain unsolved. 8 MiB is a per-object ceiling, not an exact reservation or concurrent-resource bound.
