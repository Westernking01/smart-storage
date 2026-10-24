# Fresh account development deployment checklist

Prepared only, 2026-10-23. No live requests/writes or account creation performed.
Account A/B cleanup is stopped; all their records and accounting remain intact.
ADR-041 OPEN. SMART_STORAGE_TRANSFERS_ENABLED=false throughout.

1. Obtain separate authorization for one new controlled test email/account,
   package deployment, enrollment and private credential issuance. Use the
   application's normal Supabase signup and email confirmation, then ordinary
   password login against https://fneuqneqaopkmpeevlqz.supabase.co. No admin
   impersonation, existing A/B account, injected session or anonymous login.
   Keep credentials private. Verify getUser and signed claims: confirmed,
   nonanonymous authenticated subject, issuer matching this project. Record
   the new UUID privately; reject either existing A/B UUID.
2. Read that exact UUID's profile/usage/session metadata. A fresh Auth account
   may have no application usage row yet; absence is not a confirmed numeric
   zero row. Normal ss_bootstrap or enrollment initializes it. Require no
   prior sessions/files/attempts and, if usage exists, stored_bytes=0,
   reserved_bytes=0, active_slots=0. Stop on any nonzero value. The real new
   account cannot be verified until its separately authorized creation.
3. Independently verify the administrator connection targets project
   fneuqneqaopkmpeevlqz. In that same psql session (ON_ERROR_STOP enabled):

   ```sql
   SET app.settings.project_ref='fneuqneqaopkmpeevlqz';
   \i supabase/development-cloud/install.sql
   \i supabase/development-cloud/enroll-account.sql
   ```

   Run from the repository root. Enter only the verified fresh UUID at the
   enrollment prompt. Install and enrollment are separate transactions; on
   any error stop, rollback an open transaction and review, never sweep
   migrations. No migration 004–014 or A/B cleanup is needed. Install creates
   the private smart-storage-dev-cloud bucket, restricted publisher role,
   guarded function replacements and scoped policies. Enrollment changes only
   the selected subject's profile/usage/enrollment, quota=6422528, max_slots=1.

4. Read back the exact new owner's stored_bytes=0, reserved_bytes=0,
   active_slots=0, quota_bytes=6422528, max_slots=1 and enabled enrollment.
   Verify bucket public=false, limit=6291456, octet-stream restriction; four
   trusted RPC grants only to the restricted publisher plus administrator,
   no ordinary proof grants; publisher NOLOGIN/NOBYPASSRLS and no table grants.
   Check A/B accounting against preserved predeployment values without updates.
5. Through an existing trusted same-project signing facility, privately issue
   a short-lived publisher JWT: issuer matching project, role
   ss_dev_cloud_publisher, sub matching the new owner. If no issuer is
   available, stop; a service-role token is not a substitute. Configure a
   dedicated localhost process with the existing public URL/key, development
   backend enabled, loopback APP_ORIGIN and:

   ```dotenv
   SMART_STORAGE_TRANSFERS_ENABLED=false
   SMART_STORAGE_DEV_CLOUD_ENABLED=false
   SMART_STORAGE_DEV_CLOUD_PROJECT_REF=fneuqneqaopkmpeevlqz
   SMART_STORAGE_DEV_CLOUD_BUCKET=smart-storage-dev-cloud
   SMART_STORAGE_DEV_CLOUD_RPC_ROLE=ss_dev_cloud_publisher
   ```

   Supply SMART_STORAGE_DEV_CLOUD_RPC_TOKEN and a random 32-byte lowercase hex
   SMART_STORAGE_DEV_CLOUD_PERMIT_KEY privately, server-only. Separately
   authorize localhost activation and one bounded upload/publication/download.

## Offline compatibility evidence

New in-memory PGlite PostgreSQL fixtures execute base migrations 001–003,
install, repeat install, exact enrollment SQL body and rollback. Synthetic Auth
and Storage schemas are test shims, not Supabase services. No connection URL,
protected cluster or credential is used. The test covers both clean 001–003
allocation ACL and the previously observed deployed variant with service_role
EXECUTE. A demonstrated install guard defect rejected clean 001–003; the
generator now accepts only those two exact known ACLs, retaining source hashes
and rejection of other ACLs. Rollback restores original bodies/ACLs, disables
enrollment, removes package policies and retains data. No rollback defect found.

This does not certify live Storage owner/size metadata, JWT issuance,
concurrency or production quota enforcement. Real account zero-usage readback,
secure issuer availability and separately authorized deployment remain pending.
