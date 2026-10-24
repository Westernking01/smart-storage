# Permanent development instructions

## Development authentication enabled — 2026-10-14

Local `.env.local` enables ordinary development Auth/backend connectivity only for `fneuqneqaopkmpeevlqz`. Cloud transfers remain disabled. Preserve `SMART_STORAGE_TRANSFERS_ENABLED=false`, ADR-041, and all Storage/worker/cleanup boundaries. A server running before this flag change must be restarted. Manual Auth testing is allowed by the current user request; automated tests must continue to intercept submissions unless separately authorized.

## Authentication input repair — 2026-10-14

Auth fields remain editable when backend connectivity is disabled and disable only while a submission is pending. Submit buttons remain gated by backend availability. Preserve this separation: a disabled provider must prevent requests, not keyboard entry. Chromium keyboard coverage exists for login, signup, forgot-password and update-password; never replace it with programmatic value assignment alone.

## Forgot-password repair — 2026-10-14

Local recovery-form defects are fixed: preserve email, fence duplicate submissions, show loading and privacy-safe success/error feedback, fail on provider reset errors, and skip unrelated proxy identity lookup for `/forgot-password` and `/api/auth/reset`. No live recovery request was sent. A single user-run manual request against `fneuqneqaopkmpeevlqz` is the next validation; do not automate/repeat it, reset passwords, contact the old project, or expose callback tokens.

## Phase 2.5A SSR diagnosis — 2026-10-14

Local actual-SDK SSR round-trip and proxy integration tests pass, including chunking, bearer verification, cookie propagation, invalid-session redirect and same-origin protection. Treat the Phase 2.5 manual Playwright cookie injection as a harness defect, not proof of a proxy defect. Do not use injected sessions to claim login. User A's saved password remains unreconciled after the single recorded 401; no more live Auth request, password reset or recovery without explicit authorization. A controlled browser retest needs a verified current password or separately authorized recovery. Preserve both ledgers and all Phase 2.4 resources; Storage remains prohibited and ADR-041 unresolved.

## Phase 2.5 browser validation state — 2026-10-14

BLOCKED on real browser authentication for `fneuqneqaopkmpeevlqz`. Preserve `supabase/tests/phase-2.5-ledger.json`. User A saved-password login returned 401; do not retry loops or change/reset either password without explicit authorization. Official SSR session validation returned 200 twice, but the SDK-produced cookie was rejected by the Next.js proxy. Storage/REST remained zero and Phase 2.4 resources are unchanged. Diagnose login credential state and proxy cookie recognition before resuming persistence/logout/A-B switching. No old-project access, cleanup, Storage, quota/schema/policy change or production activation. ADR-041 unresolved.

## Phase 2.4 continuation state — 2026-10-14

Live subset is PARTIAL on `fneuqneqaopkmpeevlqz`. Preserve `supabase/tests/phase-2.4-ledger.json`: Auth 11, RPC/REST 35, read-only SQL 6, Storage 0, management 2, targeted quota transaction 1. Two confirmed ordinary users have per-user quota 1048576 / slots 2; global defaults remain zero. Four files and four sessions remain. Preserve the denied mistaken POST and append-only corrected GET evidence. No cleanup, Storage validation, trusted-worker transition, old-project access, grant/RLS change or production activation without separate authorization. Browser Auth lifecycle remains unvalidated. ADR-041 unresolved.

## Phase 2.4 halted preflight - 2026-10-14

User authorized bounded Auth/RLS/reservation testing only on fneuqneqaopkmpeevlqz; Auth64/RPC96/read-only SQL128/Storage0. Actual Auth1, RPC0, SQL1 plus one management lookup. Halted because account policy remains zero quota/slots and direct SQL writes are forbidden; two approved test addresses now supplied; accounts not created. No accounts/data/session provisioning occurred. Preserve phase-2.4 ledger/counters and confirmation requirements. Any test-policy update needs explicit additional authorization. No old state/project contact, migration, RLS/Storage configuration, cleanup or cloud transfer activation. ADR-041 unresolved. See docs/phase-2.4-validation.md.

## Phase 2.3 completed scope - 2026-10-14

User authorized only three reviewed migrations and read-only catalog verification on fneuqneqaopkmpeevlqz. All three now applied/verified; do not replay. Historical local-only prohibitions are superseded for those operations only. No Auth/RPC/Storage tests, user creation, bucket/policy setup, additional seeds/migrations, cleanup, production deployment or protected-project/private-state access is authorized. Backend/transfers remain disabled; ADR-041 unresolved. Await explicit live Auth/RLS scope authorization. See docs/12-PROGRESS.md.

## Current Phase 2.1 boundary - 2026-10-14

Read-only/local readiness review and narrowly tested local corrections are authorized. No live Supabase connection, provider request, provisioning, cloud migration/configuration/cleanup, cloud transfers or access to stopped private state. Follow docs/phase-2-provider-readiness.md; its proposed budgets are not an approval. Future setup, validation and cleanup each require explicit target/scope authorization. Preserve review SQL guard/ROLLBACK and ADR-041 unresolved.

## Current Phase 2 implementation - 2026-10-14

Phase 2 local secure-backend development is explicitly authorized. This supersedes historical phase prohibitions below while preserving their evidence. Auth, owner-only metadata, local migrations, transactional reservations and account-scoped staging are implemented. Real Supabase behavior and multi-connection races remain unverified. Backend defaults disabled; cloud transfers remain disabled; ADR-041 remains unresolved. No remote resources or old experiment/private state were accessed or changed. See docs/phase-2-spec.md and supabase/README.md.

Current authorization (2026-10-13): Task 1.6 permits local architecture review, implementation-ready Phase 2 specification and narrow tested integration seams. This supersedes historical Task 1.6 prohibitions only. No Phase 2 implementation, live Supabase request, remote mutation or access to the stopped experiment/private state is authorized. ADR-041 remains Proposed/release-blocking. Production cloud authority remains disabled; safe Auth/metadata/local SQL development requires separate Phase 2 authorization. See docs/phase-2-spec.md. Historical scope entries below must not override this current boundary.

Current authorization (2026-10-13): Task 1.5 local, provider-independent staging/restoration and a labeled local-only application demo. This supersedes historical prohibitions on Task 1.5 only. Task 1.4 run p14b-20261011-c40e8e03 is permanently stopped pending separate recovery authorization: never access/decrypt/modify its real ledger, credentials or approvals, make provider requests, renew/retry it or reuse budgets. Preserve 1 allocation/474 stage bytes/327 renewal bytes/801 total, seven original stages and zero Storage continuation; User A second login is user-verified ambiguous after dispatch without completed response. No cleanup, Task 1.6 execution, Phase 2 or production release is authorized. ADR-041 unresolved. See docs/feasibility/staging-restoration.md for local implementation and remaining gates.

## Scope and reading order

1. Read this file, README, docs/12-PROGRESS.md, docs/01-PRD.md, docs/02-ARCHITECTURE.md and docs/11-DECISIONS.md before implementation.
2. Read the relevant subsystem specification and docs/10-TESTING.md before changing behavior. Map tasks to requirement IDs.
3. Inspect existing implementation and applicable nested instructions before editing. Preserve unrelated user changes.

For any frontend, styling, component or UX work, read docs/07-UI-UX.md and docs/13-DESIGN-SYSTEM.md before planning or implementation. The latter is the visual source of truth; do not substitute a generic template. Four originals are in docs/references in user-attachment order. Follow the approved synthesis: reference 2 light/details, 3 categories/folder geometry/storage/table, 4 minimal navigation/spacing, 1 statistics/quick access. Premium light theme as default is approved; frontend implementation and Phase 1 still require explicit approval.

Current authorization: Task 1.4A.1 permits creation of exactly the private smart-storage-feasibility bucket with 8388608-byte cap and application/octet-stream only, plus two ordinary development test accounts. Both smart-storage-user-a@example.invalid and smart-storage-user-b@example.invalid are explicitly approved. Do not request these approvals again. Development isolation is user-confirmed; read-only Auth connectivity and saved bucket/account metadata verification pass. Supabase project-management tools are authenticated to the configured development project. Task 1.4A.2 reviewed the grants/API exposure; the global limit is user-observed as 50 MB. The approved bucket and two ordinary accounts are now created and readback-verified; UUIDs/passwords are retained in an external protected store. The user manually deployed the four reviewed development policies; Task 1.4A.7 read-only audit verified their definitions and resources. No further policy changes or provider testing is authorized. Secrets/passwords remain private; account credentials require secure storage outside the repository. No further policy deployment, uploads, signed capabilities, provider tests, global settings, destructive rollback, Task 1.4B provider execution, Task 1.5 or Phase 2 is authorized. Task 1.4B.0 authorizes local runner preparation and mocked tests only. Hard reservation/concurrent-attempt enforcement remains a release blocker. See docs/feasibility/supabase-dev-setup.md and docs/12-PROGRESS.md.

## Repository conventions and coding standards

Current local state: Accelerated Task 1.4B recovery is complete, READY FOR RESUMPTION AUTHORIZATION. The exact directory/file ACLs were corrected without weakening validation. A narrow cross-read-B/B/A00/400/NoSuchKey/logical404/Object not found classifier and one append-only provider-log reconciliation preserve original failed entry/halt, prior journal rows and consumed 1 allocation/474 body bytes. Remaining strict budget is 2/6325062; continuation skips the original prefix without replay. Existing execution approval expired; no replacement or renewal exists. No provider request, Auth sign-in, upload/TUS, cleanup, policy/bucket/Auth change or later phase is authorized now. Known sandbox ACL entries can reappear between tool invocations: explicitly authorized guarded repair must immediately precede future ledger access in the same normal context; never bypass the validator, clear locks, reset budgets or rerun reconciliation. Any later execution needs fresh explicit user authorization and session/expiry checks. Preserve original review guard/ROLLBACK, deployment SQL, diagnostics and full ledger history. ADR-041 remains release-blocking.

Keep numbered specifications in docs and architectural decisions in 11-DECISIONS. Future application layout is proposed in architecture; do not create it during Phase 0. Use descriptive filenames, small focused modules, strict TypeScript, explicit error types and Zod validation at trust boundaries. Pin dependencies when authorized; justify new dependencies and audit their licenses and security posture. Keep provider SDK details behind adapters. Distinguish original, encoded, stored, acknowledged and attempted bytes in names and types. Never convert a large file to one ArrayBuffer or Blob merely for convenience.

## Security requirements

Verify server identity rather than trusting client claims. Enforce ownership in database and storage policies. Keep service credentials exclusively server-side. Do not log filenames, raw hashes, credentials, signed URLs or file bytes. Use private buckets and immutable paths; never use client-supplied paths as authorization. Apply bounded decoding, quota reservations and completion validation. Client reports are untrusted. Do not weaken RLS or limits to make a test pass.

## Mandatory design rules

Light is the default even when the OS prefers dark; switch to dark/system only on explicit user selection. Use a custom neutral/jade palette, consistent typography and thoughtful spacing. Keep file management, compression and data savings central. Preserve the approved folder-card visual concept while tracking operational folder scope separately; never populate it with fake data or unsupported actions.

Use official @boxicons/react as the primary icon library. Do not use Lucide or emojis as UI icons; remove Lucide usage from future shadcn-derived components. Do not mix icon libraries without explicit approved exception. Use shadcn/ui as an accessible foundation, with custom semantic tokens and purposeful components.

Follow the dark/light theme, typography, density, geometry, responsive and accessibility contracts in [13-DESIGN-SYSTEM](docs/13-DESIGN-SYSTEM.md). Prohibit uncustomized gray palettes, generic purple/decorative gradients, excessive glow, stock illustrations/cloud logos, copied branding, uniform rounded-card grids, pervasive shadows/borders, oversized spacing and generic gradient-heading/floating-card landing templates. No fabricated metrics, activity or nonfunctional production controls. Respect the existing flat-file MVP: folder concepts do not authorize folder implementation or schema changes.

Before frontend phase completion, review both themes, responsive widths, long/empty/error/progress states, contrast, keyboard/focus and real data labeling against DQ-01–10. Do not claim reference review or visual acceptance without evidence. Documentation work and a design proposal do not authorize frontend implementation.

## Verification and documentation updates

Run checks appropriate to authorized changes and report actual commands and results. For future code, require lossless round trips, corruption handling, cross-user denial, interruption recovery and accounting idempotency when affected. Do not claim tests passed when only a specification or manual review exists. Update PRD, affected specifications, decision log and progress whenever behavior, limits, schema or a phase gate changes. Record evidence before promoting a proposed decision to accepted.

## Approval and completion

Proceed autonomously with reversible work inside an approved phase. Ask before entering an unapproved phase, destructive data operations, production changes, paid resources, or publishing/deployment without existing authorization. Present concrete reviewed work and unresolved decisions before requesting approval. User instructions supersede these local conventions.

Completion reports must include: phase and outcome; changed artifacts; verification performed; requirement coverage; decisions needing approval; assumptions needing verification; known limitations; and next authorized task. Mark progress accurately and stop at the phase boundary. Never treat elapsed time or silence as approval.

## Task 1.4B.2C current boundary

Continuation approval safeguards are implemented using schema version 2 and a stable existing-ledger identity plus initial checkpoint. Exact ten-stage order, additional 2 allocations/6292512 bytes, maximum 30-minute approval and per-request expiry are mandatory. Old approvals cannot authorize reconciled continuation. Current readiness is BLOCKED: actual ledger directory again has CodexSandboxUsers read/execute ACE; inspection stopped at ACL validation, unchanged ledger bytes verified, real encrypted integrity/session expiry not refreshed. No live approval, credential decryption or provider execution occurred. See experiments/storage/provider-runner/continuation-approval-report.md. Do not initialize/reset/reconcile this ledger again or silently repair/relax ACL checks. Later live execution needs separate authorization and fresh prerequisites; expired sessions do not authorize replaying login stages. ADR-041 unresolved.

## Expired continuation session boundary

Expired verified JWTs must not be used for any request. Local Auth-only renewal implementation is ready for controlled normal-PowerShell execution after explicit interactive confirmation; no live requests are authorized by the implementation task. Use renewal-cli and session-renewal-report.md. Do not replay login/identity stage IDs, renew automatically, reset history or ignore Auth body accounting. Renewal evidence must be append-only and checkpoint-bound; session replacement requires exact ordinary identity verification. Preserve Storage schema-v2 stage/allocation/payload scope and cumulative ceilings. User independently inspected the real ledger and expired sessions; this implementation did not access them. ADR-041 unresolved.

## Final private continuation helper boundary

Use continuation-helper-cli.js --execute only from normal Windows PowerShell after explicit interactive confirmation and fresh private approval. The helper calls compiled CLI in-process; never paste confirmation IDs into shell arguments or reconstruct approval JSON. Exactly renewed usable A/B sessions, four completed Auth renewal evidence records, seven preserved original stages and ten pending Storage stages qualify. No ledger initialization, permission repair, renewal, retries, cleanup, reset or later phase. --inspect is redacted/local-only and preserves journal bytes; existing locks/pending/integrity failures require reconciliation. This implementation task did not access real ledger/credentials or provider. User-reported renewal/ACL success remains labeled as such. ADR-041 unresolved. See experiments/storage/provider-runner/private-continuation-report.md.

## Controlled second-renewal recovery (2026-10-13)

The latest user-authorized local implementation supersedes the earlier blanket second-renewal prohibition only through the explicit --renew-then-continue path. Exactly one additional four-request Auth round requires a fully completed identity-verified first round, zero Storage continuation progress, a fresh private round-2 checkpoint-bound approval and separate human confirmation. Storage still needs its own ten-stage confirmation with additional limits 2 allocations/6292512 bytes. Both histories and cumulative Auth accounting are preserved; no third renewal, retry, reset, cleanup or lifetime-threshold reduction. Implementation uses disposable fixtures only; real ledger, credentials and provider remain untouched. See experiments/storage/provider-runner/renew-then-continue-report.md for the exact normal-PowerShell procedure and evidence limits. ADR-041 remains unresolved.

## Interrupted second renewal investigation (2026-10-13)

Current outcome: BLOCKED — AMBIGUOUS AUTH REQUEST pending a normal-Windows --diagnose-renewal read-only report. User-reported counters are 1 allocation, 474 stage bytes, 327 renewal bytes, 801 total bytes, zero Storage continuation. The extra 109 bytes do not establish delivery or success. The native dispatch marker precedes fetch, and no durable response-received marker exists. A minimal completion-error correction reloads integrity before appending failure evidence and preserves completed responses. No real ledger/credentials/approvals were accessed, no provider requests occurred, and no reconciliation, third renewal, retry, cleanup or continuation is authorized. See experiments/storage/provider-runner/interrupted-renewal-report.md for the exact diagnostic command and evidence requirements. Earlier READY implementation statements are historical; runtime recovery remains blocked. ADR-041 unresolved.
