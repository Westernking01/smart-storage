# Development cloud deployment candidate

2026-10-23: the four confirmed variable/alias collisions are corrected offline.
For the already-installed backend, review the narrowly scoped
[alias correction and rollback](ALIAS-CORRECTION.md); do not re-run the full
installer as an upgrade. The direct PostgreSQL publisher candidate avoids custom
JWT signing but remains unwired pending hosted contract/connection qualification.
See [current design](../../docs/development-cloud-postgres-publisher.md). Historical
JWT issuance/configuration instructions below are not an activation instruction.

Development deployment candidate. SQL compatibility is now exercised only in fresh in-memory disposable PostgreSQL fixtures with synthetic Auth/Storage schemas; no live SQL, resources, credentials or transfers were performed. ADR-041 OPEN. Production transfers remain disabled. Use the [fresh-account deployment checklist](FRESH-ACCOUNT-CHECKLIST.md); preserve all existing A/B reservations.

## Scope and dependencies

Target only `fneuqneqaopkmpeevlqz`. Independently check the deployment connection's project before setting session `app.settings.project_ref` to that reference; the setting is an operator assertion, not project discovery. Run `install.sql` as the database administrator after authorization. It checks predecessor function source hashes and saves original definitions before replacement. Bucket provisioning is idempotent: existing exact configuration is retained; configuration drift aborts. Reapplying the installed package preserves backups and checks installed function hashes. Do not use a migration-directory sweep.

Required: deployed 001 tables/quota constraints, 002 ordinary identity/reservation/metadata contracts, 003 request fences/observations/finalization and owner SELECT policies; Supabase managed Storage tables/RLS and ordinary Storage API table privileges. No dependency from 004–014 is required:

| Migrations | Reason excluded |
| --- | --- |
| 004 | Independent gateway claim/enrollment state; closes legacy request paths for enrolled sessions. |
| 005 | Gateway resource/evidence receipts; not used by this legacy-compatible adapter. |
| 006 | Gateway preparation, cleanup and settlement; no cleanup authorized here. |
| 007 | Gateway lifecycle extensions; not called by development cloud. |
| 008 | Gateway write observations; adapter uses the four 003 RPCs. |
| 009 | Gateway dispatch scope; no gateway dispatch RPC is called. |
| 010 | Gateway-only admission would conflict with this direct ordinary Storage path. |
| 011 | Local volume lifecycle; not a Supabase object prerequisite. |
| 012 | Prepared-block gateway authority; separate architecture. |
| 013 | Prepared manifest registration for that authority. |
| 014 | Prepared registration plans for that authority. |

## Authority and evidence

Only the user-selected confirmed ordinary subject may be enrolled. After the user signs in and verifies their UUID/project, separately authorize `enroll-account.sql`. It creates no Auth account; it provisions application profile/usage only, requires zero existing usage, caps quota at 6 MiB + 128 KiB and one slot, and leaves global account defaults unchanged. No other account is selected or modified. Bucket `smart-storage-dev-cloud` is private, octet-stream only, with a 6 MiB per-object limit. Manifest limit is 128 KiB in finalization.

Allocation retains base owner/session locks, immutable block checks, quota reservation, epoch and ambiguity checks. It adds allowlist enrollment, a single block, 1–6 MiB original/encoded bounds, encoded size no larger than original, quota/held-slot binding and a one-attempt limit before returning authority. Storage INSERT requires exact allocated path and an in-flight reserved request; manifest INSERT requires present blocks. SELECT requires exact owner/session membership. There are no UPDATE/DELETE policies, no ordinary publication grants and no signed-upload workaround.

The NOLOGIN `ss_dev_cloud_publisher` role has only public schema usage and EXECUTE on `ss_begin_attempt_request`, `ss_finish_attempt_request`, `ss_record_observation`, `ss_finalize_verified`; no table, Storage, cleanup, role-management or BYPASSRLS privileges. Its verified signed JWT must have same-project issuer, role and **sub equal to the enrolled ordinary owner**, plus short expiry. Granting membership to `authenticator` permits PostgREST role selection; it does not create an issuer. A trusted operator must issue the token through an existing secure same-project signing facility, outside repository/history/logs. If no such issuer exists, activation remains blocked; do not substitute service_role or generate a browser credential.

Trusted functions reject other subjects/roles. Observation requires an acknowledged, fully counted exact path with matching stored object owner/size. Finalization requires actual matching manifest object metadata, then retains 003 exact manifest/block membership, hashes, present-observation and accounting checks. The existing server independently reads encoded objects, hashes bytes, restores and verifies original SHA-256, uploads the canonical manifest, reads/hashes it and only then invokes publication. SQL metadata is not cryptographic proof: the server publication credential is the trusted byte-verifier boundary. A compromised signer/server can attest false digests; ordinary clients cannot call proof functions. Do not claim provider-level strict quota or production ADR-041 acceptance: direct ordinary Storage access cannot prove all provider ingress/concurrency guarantees.

## Configuration and activation actions

In a dedicated localhost process keep existing approved Supabase URL/public key and set `SMART_STORAGE_ENV=development`, `SMART_STORAGE_BACKEND_ENABLED=true`, `APP_ORIGIN=http://localhost:3000`, `SMART_STORAGE_TRANSFERS_ENABLED=false`. Set `SMART_STORAGE_DEV_CLOUD_PROJECT_REF=fneuqneqaopkmpeevlqz`, `SMART_STORAGE_DEV_CLOUD_BUCKET=smart-storage-dev-cloud`, and server-only `SMART_STORAGE_DEV_CLOUD_RPC_ROLE=ss_dev_cloud_publisher`. Supply a fresh random 32-byte lowercase hex `SMART_STORAGE_DEV_CLOUD_PERMIT_KEY` and the short-lived `SMART_STORAGE_DEV_CLOUD_RPC_TOKEN` privately. Keep `SMART_STORAGE_DEV_CLOUD_ENABLED=false` until separate activation approval. No NEXT_PUBLIC secret, service credential fallback, production config change or local database/ACL inspection is needed.

Deployment authorization must cover install.sql (bucket metadata, private tables/functions, five guarded replacements, role/membership/grants and three policies); enrollment SQL for the exact user-verified UUID and quota; secure credential issuance and local configuration. Separate first-transfer authorization covers eventual localhost enablement and one tiny fixture compression/upload/publication/download with independent original SHA-256, denied cross-user access and no automatic retry/cleanup. Before activation review managed Storage owner_id/size behavior and effective role privileges; offline source checks do not qualify deployed RLS or concurrency behavior.

## Rollback

Stop app and disable development flag; revoke/expire token. Separately authorized `rollback.sql` disables enrollment, revokes authenticator membership, restores saved base definitions and original base trusted service_role grants, removes publisher execution and only these three policies. It retains bucket/objects/rows/holds for reviewed disposition; it never releases quota or deletes objects. Existing policy/function drift must stop rollback for review. Enrollment quota/profile restoration and role/bucket deletion require separate review, particularly after any real usage. After rollback reinstall needs explicit review because installed-source hashes intentionally no longer match.

## Offline validation boundary

`node scripts/prepare-dev-cloud-package.mjs` generates install.sql from checked-in 002/003 plus template/policies. Focused tests inspect guard ordering, evidence/permission boundaries and generation reproducibility. `development-cloud-install.test.ts` executes 001–003, install, repeat install, fresh fixture enrollment and rollback in disposable PGlite, checking zero usage and restored function bodies/ACLs for both known allocation ACL variants. The demonstrated clean-predecessor ACL guard defect is corrected without accepting arbitrary grants. Live effective ACLs, managed Storage behavior and multi-connection behavior remain unverified. No protected cluster or live database was contacted.
