2026-10-17: migration 202610170011_local_volume_lifecycle.sql is local-only and undeployed. It reuses 001-010 accounting and adds the separate restricted local-volume lifecycle. No existing database, remote resources, users, quotas or runtime login changed. Runtime/volume prerequisites and limitations: [local volume lifecycle](../docs/local-volume-lifecycle.md). Supabase Auth/PostgreSQL remain the control plane; encoded bytes use the gateway volume. ADR-041 open; production transfers disabled.

# Local backend setup and validation

## Phase 2.4 development validation state

The two approved confirmed identities in `fneuqneqaopkmpeevlqz` have per-user quota `1048576` and max slots `2`; global `account_policy` defaults remain zero. This was one guarded, already-executed test transaction, not a migration or reusable deployment instruction. Live validation is partial; four files and four sessions remain, Storage was not contacted, and cleanup requires separate authorization. See `docs/phase-2.4-validation.md` and the append-only ledger.

The three reviewed database migrations were deployed and catalog-verified in Phase 2.3 on fneuqneqaopkmpeevlqz. Do not reapply them. Storage review policies remain undeployed. Do not use the stopped feasibility project. Ordinary application routes need only the public key. Earlier proposed commands below are historical, not repeat-execution instructions.

1. Use pinned npm 11.13.0 and Node >=22.12 <25. Run npm ci, npm run typecheck, npm run lint, npm test, npm run test:database and npm run build.
2. The database suite applies three migrations in filename order to disposable embedded PostgreSQL with synthetic Auth roles/functions. It does not connect to Supabase. Run npm run test:e2e with available Playwright Chromium.
3. Future separately approved fresh development validation must review/apply these transactional migrations using supported Supabase tooling. Review account_policy before configuring nonzero quota/slots; defaults fail closed. Do not deploy to existing cloud resources without explicit approval.
4. Configure .env.local from .env.example with an approved new development URL/public key, SMART_STORAGE_ENV and exact APP_ORIGIN. Backend defaults false; enable only for approved validation. Keep SMART_STORAGE_TRANSFERS_ENABLED=false. Never expose service credentials.
5. Configure Auth redirects/email templates for /auth/callback using supported PKCE or token_hash email/recovery links. Test confirmation, login/logout, recovery, revoked/expired identity and two-user isolation against real GoTrue.
6. Storage bucket.config.json is a specification, not a resource. Use a supported API after separate approval. policies.review.sql deliberately raises a guard and ends with ROLLBACK. Five policies have grammar evidence only; provider helpers/bypass require validation. Do not insert Storage system rows or modify managed grants.

Privileged cloud lifecycle adapters are absent. SQL reservations do not enforce physical pre-write limits. Finalization tests use synthetic trusted proofs, not actual cloud digest verification. Cleanup jobs do not run automatically. PGlite uses one connection, so queued reservation tests are not independent-connection race proof. Distributed Auth throttling and data-plane evidence remain release gates. ADR-041 remains unresolved.

## Phase 2.1 readiness review - 2026-10-14

Local review is CONDITIONAL. Numeric manifest types corrected; five Storage predicates and execution/search-path boundaries exercised in disposable PostgreSQL with synthetic Auth/Storage helpers. Live provider semantics and independent-connection races remain unverified. See [readiness plan](../docs/phase-2-provider-readiness.md) for the proposed bounded fresh-project manifest, target/mailbox/secret requirements and separate setup/test/cleanup approvals. No cloud connection/change or old private-state access occurred. ADR-041 unresolved; transfers disabled.

## Phase 2.2 verified local target and proposed next commands

Local URL reference fneuqneqaopkmpeevlqz is distinct from the stopped project. User-reported Dashboard name smart-storage-dev is not independently confirmed. Next environment loading and offline SSR initialization passed; zero network requests. Missing non-secret development flags/origin were added to .env.local; backend and transfers remain false. TypeScript and 20 focused tests passed. No cloud setup is complete merely because the URL/key format passes.

Local-only checks (no cloud mutation):

```powershell
node .cache/phase-2-baseline/env-preflight.mjs
npm.cmd run typecheck
node node_modules/vitest/vitest.mjs run tests/unit/backend.test.ts tests/unit/server-boundaries.test.ts
npm.cmd run test:database
```

Future SQL execution proposal, **NOT executed or authorized**: first approve read-only target/health/catalog checks and separately approve these exact three migration hashes. Use Dashboard SQL Editor opening each migration in filename order, or an approved PostgreSQL client. No Supabase CLI configuration/link exists in this repository; do not assume db push is ready. psql availability/connection credentials have not been verified. The following commands connect remotely and mutate database objects. Supply the separately approved NEW target via protected PG environment/password-file configuration outside command arguments; do not paste connection URLs/passwords into terminal commands. Verify target identity before execution. Each file owns its transaction; stop on any error or ambiguous outcome, inspect history before retrying.

```powershell
# FUTURE CLOUD MUTATION: separate explicit approval required.
foreach ($migrationFile in @(
  'supabase/migrations/202610130001_backend_schema.sql',
  'supabase/migrations/202610130002_control_functions.sql',
  'supabase/migrations/202610130003_trusted_transitions_and_rls.sql'
)) {
  psql -X --set=ON_ERROR_STOP=1 --file=$migrationFile
  if ($LASTEXITCODE -ne 0) { throw 'Migration stopped; inspect before retrying.' }
}
```

Future read-only validation statements (also live provider requests requiring approval):

```sql
SELECT current_database(), current_user, version();
SELECT table_name FROM information_schema.tables
WHERE table_schema IN ('public','app_private') ORDER BY table_schema,table_name;
SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
FROM pg_policies WHERE schemaname IN ('public','storage')
ORDER BY schemaname,tablename,policyname;
SELECT p.oid::regprocedure,p.prosecdef,p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') AS worker_execute
FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'ss_%'
ORDER BY p.proname;
```

Expected: nine public app tables, two private tables, 17 ss_* functions with empty search paths, ten ordinary control RPCs/seven worker-only RPCs, owner SELECT RLS and no ordinary app DML. Other provider-managed public objects may exist and require preflight inventory. Catalog listing alone does not prove FKs/triggers/complete grants; the bounded readiness plan requires full definition comparison and independent-connection/JWT tests. Storage policies/bucket/accounts are separate approved setup steps, not these migration commands. Do not run guarded Storage review SQL as deployment or set backend true before separate live authorization.

## Phase 2.3 database deployment - 2026-10-14

**SUCCESS** for authorized reference fneuqneqaopkmpeevlqz. Supabase plugin management/read-only SQL confirmed ACTIVE_HEALTHY, PostgreSQL 17.11 and actual project name smart-storage-test (different from user-reported smart-storage-dev). Explicit reference is authoritative; old project was never contacted. Before deployment: no migration history, app_private schema, application relations/functions or public/Storage policies; executor postgres had required public CREATE/Auth USAGE/REFERENCES. No reset/conflict/unrelated change needed.

Applied exact reviewed source via Supabase apply_migration, each in order and once, all returned success:

| Local identifier/name                    | Provider migration version | Source SHA-256                                                   |
| ---------------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| 202610130001_backend_schema              | 20261013234412             | 0d8aa2eefe6a722e5c5c3ed4601dddb1c5545675606d098d1e51884c12d0d827 |
| 202610130002_control_functions           | 20261013234421             | 8398c62975c8e8d8cf428f658313a616d9d8f007bfca4f695844005525783513 |
| 202610130003_trusted_transitions_and_rls | 20261013234431             | f3825a35842f5f93a6182ee3dc1c767be479b8b888e973e20066db8fa229a6f8 |

Provider history contains exactly these names in order; provider-generated versions differ from local filename IDs. Each history entry stores one complete SQL script; its MD5 equals the exact local source (MD5 used only for read-back comparison, source SHA-256 retained). Catalog audit timestamp 2026-10-13T23:46:33.283605Z / 2026-10-14 Africa/Lagos.

Read-only catalog comparison to a disposable database built from the same sources: 11 tables (9 public +2 private), 117 columns/defaults/nullability, 94 PK/FK/unique/check constraints, 31 indexes, 8 exact SELECT owner RLS policies, 10 ownership/history/lifecycle triggers, 23 functions (17 ss_* +6 helpers) match. PostgreSQL 18 locally adds 96 NOT NULL pg_constraint entries absent on PostgreSQL 17; compare attnotnull separately and omit only those extra local catalog entries. Normalized comparison passes with zero remaining differences. Evidence: supabase/tests/deployment-2.3-catalog.json and deployment-2.3-comparison.json.

RLS enabled on all nine public tables and private attempt_requests. Private operator-only account_policy intentionally has no RLS and no ordinary table grants. Table owners postgres. Authenticated users have eight SELECT grants/policies, no cleanup/private table reads or DML; anonymous app reads/writes absent. No PUBLIC EXECUTE on deployed ss_* or app_private functions; ten controls executable by authenticated, seven trusted lifecycle RPCs deny authenticated/anon and grant service_role. Definer functions use empty search paths; exact source/signatures/config compared. app_private USAGE authenticated true, anon false; authenticated CREATE false; no unexpected ordinary non-SELECT grants. Storage RLS remains enabled, ownership supabase_storage_admin unchanged, Storage policies remain zero. No bucket/Auth configuration or resources created.

Deployment made only changes intrinsic to the reviewed files, including fail-closed account_policy row (quota/slots zero); no additional seeds/test users or application-data writes in verification. Four read-only SQL tool requests (initial multipart inspection 6 statements, consolidated preflight, catalog and supplemental privilege/history inspection) and three migration applications; two migration-history tool reads and one project lookup. No Auth/RPC/Storage requests or retries. Migration scripts have 66 top-level statements including transaction boundaries; reviewed DO blocks execute their own enumerated grant/RLS/trigger operations, not additional scenarios. The initial multipart inspection tool returned only one result set, so consolidated JSON was used for full read-back rather than assuming missing output meant empty state.

Local verification after deployment: TypeScript passed; all migration/Storage-review SQL and PLpgSQL grammar passed; 12 embedded PostgreSQL tests passed; production build with backend disabled passed. These local synthetic Auth/Storage tests do not prove live cross-user isolation, Auth/cookie flows, independent-connection races or provider data-plane security. No failed/ambiguous migration occurred. No SQL source/adapter/dependency/env values changed. Historical deployment restrictions/statuses are superseded for these three migrations only. Guarded Storage policy remains undeployed, cloud uploads disabled, ADR-041 unresolved. Next authorization: bounded live authentication and RLS testing; any account-policy update, test identity creation, Auth settings, Storage setup/fixtures or cleanup requires separately explicit scope.
