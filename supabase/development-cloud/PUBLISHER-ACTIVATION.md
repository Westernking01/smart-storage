# Restricted direct publisher preparation — 2026-10-23

FR-05/08/09/11/18, NFR-02. Target `fneuqneqaopkmpeevlqz` only. User reports
alias correction deployed. No live connection or SQL execution was performed by
this preparation. ADR-041 OPEN; `SMART_STORAGE_TRANSFERS_ENABLED=false` and
`SMART_STORAGE_DEV_CLOUD_ENABLED=false` remain required. Runtime selection stays
unwired. No credentials generated, read or stored; no JWT signing-key changes.

## Files and exact authority

`provision-publisher-login.sql` is a psql transaction requiring an externally
verified project pin, postgres session, PostgreSQL 16+, current installed hashes,
alias correction and absent login. Creates only `ss_dev_cloud_publisher_login`,
LOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE,
NOREPLICATION, CONNECTION LIMIT 2, PASSWORD NULL. The only grants are:

```sql
GRANT CONNECT ON DATABASE postgres TO ss_dev_cloud_publisher_login;
GRANT ss_dev_cloud_publisher TO ss_dev_cloud_publisher_login
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
```

No EXECUTE, table, sequence, schema, ownership or administrative grant is added.
SET ROLE supplies existing public-schema USAGE and exactly these four RPCs:

- `public.ss_begin_attempt_request(uuid,bigint,uuid,bigint)`
- `public.ss_finish_attempt_request(uuid,bigint)`
- `public.ss_record_observation(uuid,bigint,bigint)`
- `public.ss_finalize_verified(uuid,jsonb,bigint,text,text)`

The shared read-only assertion checks role attributes, direct membership options,
absence of further membership edges (except the exact automatic creator grant below), effective application routine privileges,
relation/column/sequence privileges, schema ownership/CREATE, database CREATE and TEMP provenance,
and each RPC's owner, SECURITY DEFINER and empty search_path. System catalog
functions remain normal PostgreSQL facilities; this is not a SQL sandbox.
Standard pg_catalog visibility and PUBLIC privileges cannot be denied to one role.

**Stop on any unexpected exposure.** Ordinary inherited PUBLIC database TEMP is
accepted following the [TEMP call-chain audit](../../docs/development-publisher-temp-audit.md).
Explicit TEMP grants to either publisher role, including redundant grants, and
PUBLIC TEMP grant options are rejected. No global or per-role TEMP changes are
needed. PUBLIC EXECUTE on unrelated accessible routines still blocks provisioning
atomically. The shared assertion pins the audited helper/trigger bodies and owners;
helper drift blocks provisioning, preflight and rollback pending review.
Recheck after schema/ACL/role changes; this is a catalog snapshot, not a future
privilege guarantee. The supplied read-only live result reported no accessible
publicly executable non-system routines; this task made no live requests.

## PostgreSQL 17 creator membership correction

The earlier assertion rejected the automatic creator-management row produced by
non-superuser CREATEROLE postgres. In GRANT syntax the LOGIN is granted to
postgres: postgres is a member of the LOGIN, not the reverse. PostgreSQL records
bootstrap grantor OID 10, ADMIN true, INHERIT false and SET false. The revised
assertion permits only that exact incoming row when postgres is a non-superuser
with CREATEROLE. It still rejects every other incoming LOGIN membership and
preserves the LOGIN's single SET-only publisher membership. No GRANT or REVOKE
in provisioning or rollback changes. Do not revoke PostgreSQL's creator grant.

The reported failed live transaction was rolled back and the LOGIN was confirmed
absent. Historical deployment procedure (not authorization for this repair): in a separately authorized, independently verified
project-owner Session Pooler psql session, with session_user=current_user=postgres
and both transfer flags false, set the external project pin and rerun the updated
provisioning script from repository root:

```sql
SET app.settings.project_ref='fneuqneqaopkmpeevlqz';
\i supabase/development-cloud/provision-publisher-login.sql
```

Stop after COMMIT and record a sanitized result; do not generate/configure a
password or enable transfers in this step. On any error, ROLLBACK and stop.
The later Session Pooler qualification section supersedes the original direct-only
endpoint restriction. Restricted-login TLS
preflight is a later credential-dependent step under its existing scope.

[PostgreSQL 17 role-attribute semantics](https://www.postgresql.org/docs/17/role-attributes.html)
and [membership catalog direction](https://www.postgresql.org/docs/17/catalog-pg-auth-members.html).

## Server identity and connection reuse

Ordinary Supabase session verification still checks signature/project, authenticated
role, expected subject and expiry. The adapter verifies before checkout and again
after checkout, requiring the same owner. Each dedicated checkout executes DISCARD
ALL outside a transaction, clearing roles, legacy claims, search_path, prepared
state and other settings, then BEGIN and explicit local timeouts/search_path.
It checks session_user, sets the local publisher role, clears request.jwt.claim,
request.jwt.claim.sub and request.jwt.claim.role, and replaces request.jwt.claims
with verified subject, fixed publisher role and is_anonymous=false. All context
is transaction-local. Failed operations roll back and destroy the connection;
uncertain commit is never retried. The pool must not be shared with general SQL.

The login is trusted server authority across enrolled accounts: PostgreSQL does
not validate signatures on claim GUCs and a stolen credential could impersonate
an enrolled subject. Database owner/enrollment checks and ordinary session
verification remain mandatory; this credential must be server-only. It is never
a browser or end-user credential. No RPC arguments supply identity.

## Exact deployment sequence (requires separate live authorization)

1. Keep both transfer flags false, stop the app/dedicated pool, review all four SQL
   files together and independently verify the development project. Do not replay
   install.sql or the deployed alias correction. Do not execute migrations 012–014.
2. In a securely authenticated postgres psql session to the verified development
   host, set `app.settings.project_ref='fneuqneqaopkmpeevlqz'` externally. Run
   `\i supabase/development-cloud/provision-publisher-login.sql` from repository
   root. Relative includes resolve beside the SQL file. ON_ERROR_STOP is enabled.
   Any failure: ROLLBACK, inspect, stop; do not relax checks or automatically retry.
3. Only after successful commit, separately configure a private strong password
   interactively using psql `\password ss_dev_cloud_publisher_login` with SCRAM
   (`SHOW password_encryption` must be scram-sha-256). Never put it in SQL files,
   command arguments, logs, chat or shell history. Provisioning itself leaves the
   password NULL and cannot be used to authenticate. No credential is supplied here.
4. Confirm either the existing direct host with the unsuffixed dedicated login,
   or the verified Session Pooler endpoint aws-0-eu-west-1.pooler.supabase.com:5432
   with username ss_dev_cloud_publisher_login.fneuqneqaopkmpeevlqz. The database
   remains postgres and SQL session_user/current_user must be the unsuffixed LOGIN.
   Only these exact pairs are accepted by the Node adapter. Transaction/statement
   pooling and port 6543 are unsupported: DISCARD ALL requires a dedicated session.
5. Use the next read-only Session Pooler command below with the downloaded trusted
   Supabase CA. Client certificate-chain and hostname verification are mandatory;
   backend pg_stat_ssl describes a different hop and is not a client TLS gate.
   The preflight prints psql client connection information, resets the dedicated
   session, runs permission auditing in BEGIN READ ONLY, tests SET LOCAL ROLE and
   synthetic transaction-local claims, rolls back and checks role/claim restoration.
   It makes no publication RPC, application data or Storage request.

6. Keep the URL only in a server secret named `SMART_STORAGE_DEV_CLOUD_DATABASE_URL`;
   percent-encode password characters. No NEXT_PUBLIC variant. This is a reserved
   input for later wiring, not currently consumed by developmentCloudRuntime.
   The Node adapter requires verified TLS and TLS >=1.2; if a private CA is needed,
   provide it through the server process trust store (e.g. NODE_EXTRA_CA_CERTS at
   process startup). Never bypass rejectUnauthorized. Restart after trust changes.
7. Stop after recording sanitized preflight outcome. A passing psql preflight
   does not certify the Node runtime handshake, ordinary Auth, provider evidence,
   or concurrency. Runtime wiring and bounded qualification need separate scope;
   do not enable either transfer flag as part of provisioning.

Rollback: stop and close all dedicated connections, verify the same admin session
and external project pin, then run `rollback-publisher-login.sql`. It validates
the restricted role shape and permission closure, refuses active sessions, clears
the password, revokes only the two grants and drops only the dedicated login.
Unexpected dependencies cause atomic failure; no DROP OWNED/CASCADE, forced
termination, publisher-role change, accounting or object deletion is performed.
If drift blocks rollback, stop for an explicit containment review.

Sources: [PostgreSQL role membership options](https://www.postgresql.org/docs/17/sql-grant.html),
[Supabase direct connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Original direct-only verification (historical)

The Session Pooler section below supersedes the original backend TLS assertion.

`node node_modules/vitest/vitest.mjs run --no-file-parallelism
tests/unit/development-publisher-activation.test.ts
tests/unit/development-publisher-postgres.test.ts
tests/unit/development-cloud.test.ts` — 32/32 PASS.

Disposable embedded PostgreSQL tests execute the actual provisioning/assertion/
rollback SQL (psql includes expanded locally), prove atomic PUBLIC TEMP and
unrelated-routine rejection, column-grant and inheritance drift rejection,
SET-only membership, denied admin role/table/unrelated RPC/temp operations,
DISCARD ALL claim/role cleanup and non-TLS preflight rejection. Existing captured
hosted-helper fixtures test wrong owner/role/missing identity and finalization.
Adapter mocks test reuse with different subjects, missing identity, expiry before
and after checkout, identity change and destruction after failures. Ordinary
session verifier tests cover expired and wrong-owner/role sessions independently.

TypeScript `--noEmit`, scoped ESLint `--max-warnings=0` and scoped Prettier checks
pass. No native LOGIN, real TLS handshake, live catalog qualification or transfer
result is claimed. The preflight success branch still needs the actual trusted
client/TLS connection; its embedded test establishes refusal without TLS.

One next action: review this guarded package and separately authorize a bounded
development deployment/preflight. If PUBLIC privilege closure fails, stop without
creating a usable login; do not proceed to credentials, runtime wiring or transfers.

## Membership repair verification ? 2026-10-23

FR-05/08/09/11/18, NFR-02. Native disposable PostgreSQL 17.11 reproduced the
original membership assertion failure with non-superuser postgres CREATEROLE;
ROLLBACK left no LOGIN. Revised provisioning, the real restricted-login shared
assertion, SET ROLE, denied SET ROLE postgres and rollback all passed. The
bootstrap-granted management membership disappeared with DROP ROLE; the publisher
role remained. Run locally with:

```text
node scripts/test-publisher-membership-postgres17.mjs
```

The harness initializes a fresh loopback-only trust-auth cluster in an OS temporary
directory using installed PostgreSQL 17 binaries, creates no password, ignores all
connection URLs and stops its cluster in finally. It retains disposable local
evidence. Override only the binary directory with PUBLISHER_TEST_PG_BIN if needed.
It makes no hosted connection and does not test Session Pooler or TLS.

Five focused suites passed 42/42, including superuser and managed creator
provision/assert/rollback variants and rejection of extra members or unsafe
ADMIN/INHERIT/SET options. TypeScript, scoped lint and formatting were checked
separately. No live writes, password generation or transfer activation occurred;
ADR-041 remains OPEN and both transfer flags remain false.


## Inaccessible monitoring-view assertion repair ? 2026-10-23

FR-05/08/09/11/18, NFR-02. The operator-supplied read-only live facts report
PUBLIC-inherited SELECT on extensions.pg_stat_statements and
extensions.pg_stat_statements_info, no extensions schema USAGE, no other
non-system relation SELECT exposure, and an absent LOGIN after rollback.
This repair made no live connection or changes.

The shared assertion permits only ordinary PUBLIC SELECT on those two exact
view identities while the checked role lacks schema USAGE. Effective privileges
alone do not establish accessible relations: schema USAGE is also required.
This is not a monitoring-schema or general PUBLIC exemption. Direct role grants
(including redundant SELECT and column grants), PUBLIC grant options/column
ACLs, writes, ownership and every other relation remain rejected even in an
inaccessible schema. Schema CREATE still fails; adding schema USAGE makes the
monitoring SELECT fail. Routine, database and PostgreSQL 17 creator membership
checks are unchanged. No global REVOKE or provisioning grants were added.

Regression fixtures use synthetic views, not the pg_stat_statements extension.
Both views are covered separately, including PUBLIC/role schema USAGE and CREATE,
explicit SELECT/column SELECT, all table write privileges, grant options,
ownership, unrelated inaccessible views/tables, failed provisioning rollback,
restricted-login and SET ROLE access denial, and successful targeted rollback.
The same fixture matrix runs in embedded PostgreSQL (both creator variants) and
a disposable loopback-only native PostgreSQL 17 cluster.

Next action: review the corrected assertion and local evidence before separately
authorizing any live provisioning retry on fneuqneqaopkmpeevlqz. This task does
not authorize a retry, credentials, runtime wiring or transfer activation.
ADR-041 remains OPEN; both transfer flags remain false.

Verification: three focused Vitest suites passed 33/33; native PostgreSQL 17.11
passed the shared monitoring regression matrix, restricted-login assertion,
SET ROLE, schema access denial, membership escalation denial and both rollback
paths. TypeScript --noEmit, scoped ESLint --max-warnings=0 and scoped Prettier
checks passed. Native evidence uses synthetic local resources and does not
qualify hosted extension contents, TLS or Session Pooler behavior.


## Session Pooler qualification - 2026-10-23

FR-05/08/09/11/18, NFR-02. Operator-verified: restricted LOGIN provisioned with
SCRAM-SHA-256 and authenticated through the exact Session Pooler endpoint using
TLS 1.3, verify-full and the downloaded Supabase CA. Both SQL identities equal
the unsuffixed LOGIN. Backend pg_stat_ssl.ssl=false is consistent with client TLS
terminating at the pooler; it does not disprove client TLS. These are supplied
facts, not live checks performed during this repair.

The adapter retains certificate verification, TLS >=1.2 and explicit endpoint
SNI/hostname. URL query/hash options cannot override TLS. It keeps its existing
DISCARD ALL, verified ordinary-session subject binding, local role/claims, COMMIT
or ROLLBACK, destroy-on-error and no-retry behavior. Use NODE_EXTRA_CA_CERTS at
process startup for the trusted downloaded CA if Node needs it; psql's sslrootcert
setting does not configure Node. No CA trust bypass or new runtime wiring added.

The SQL preflight deliberately attests to permissions/session state only. SQL
cannot verify the first TLS hop or the client's verify-full configuration. Run it
only with the command below; inspect the client connection report for TLS 1.2/1.3.
Its synthetic UUID does not authenticate an account or qualify publication RPCs.
No Auth helper, publication function, application row or Storage operation is
invoked. The unchanged shared audit still enforces membership and grant closure,
including the narrowly scoped inaccessible monitoring-view rule.

Next command, from the repository root in PowerShell (prompts for CA path and
password separately; neither password nor URL is placed in history):

```powershell
$publisherCa = (Resolve-Path -LiteralPath (Read-Host 'Downloaded Supabase CA path')).Path.Replace('\', '/').Replace("'", "\'")
psql "host=aws-0-eu-west-1.pooler.supabase.com port=5432 dbname=postgres user=ss_dev_cloud_publisher_login.fneuqneqaopkmpeevlqz sslmode=verify-full sslrootcert='$publisherCa' ssl_min_protocol_version=TLSv1.2 gssencmode=disable connect_timeout=5" -W -X -v ON_ERROR_STOP=1 -f supabase/development-cloud/publisher-preflight.readonly.sql
```

Stop on any error; do not relax TLS or permission checks. Record only sanitized
PASS/FAIL and client TLS protocol. This task made no live request or database
change, handled no password and changed neither transfer flag. Both flags must
remain false; ADR-041 OPEN. Remaining gates: operator-run revised pooler preflight,
Node-to-pooler verified TLS with its configured CA trust, and separately scoped
runtime/identity/publication qualification. A local simulated backend hop is not
proof of hosted pooler connection reuse or TLS.

Sources: [Supabase session mode](https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO),
[node-postgres TLS options and URL override warning](https://node-postgres.com/features/ssl),
[libpq verify-full and TLS parameters](https://www.postgresql.org/docs/17/libpq-connect.html).

Local verification: three focused Vitest suites PASS 52/52, including pinned
endpoint/login/TLS configuration, rejected TLS URL overrides, real adapter
reset/local identity/COMMIT restoration for two subjects, permission regressions
and uncertain-connection destruction. Native PostgreSQL 17.11 PASS, including
actual psql execution of the preflight, backend ssl=false, dirty-state reset,
repeated role/identity restoration and existing membership/monitoring rollback
regressions. The native test harness sends DISCARD ALL separately from its next
SQL batch to match psql statement boundaries. Local native transport is explicitly
not TLS evidence. TypeScript, scoped ESLint and scoped Prettier PASS.

## Node.js read-only TLS qualification � 2026-10-23

Operator reports the hosted psql preflight PASSED with verified TLS 1.3 and an
intentional ROLLBACK. Node qualification is prepared locally, not executed hosted.
ADR-041 OPEN; both transfer flags remain false. FR-05/08/09/11/18, NFR-02.

Changed runner files: `scripts/qualify-publisher-tls.mjs` (offline transpilation
and explicit execution wrapper), `scripts/publisher-tls-qualification.ts` and
`tests/unit/publisher-tls-qualification.test.ts`. The existing adapter is unchanged.
The runner reuses its pinned connection parser and pg driver, supplies an explicit
trusted CA and Node's default hostname checker, then inspects the actual client
TLSSocket for authorization, hostname and TLS 1.2/1.3. It uses the unchanged shared
permission audit and read-only preflight, including authenticated SQL login,
restricted membership, SET LOCAL ROLE, synthetic local claims, ROLLBACK and
restored login/claim checks. DISCARD ALL runs separately before the SQL batch.
Every outcome closes the dedicated client; errors are fixed redacted messages.
No retry, publication RPC, upload, application runtime or flag mutation exists.
No secrets or env files are loaded by the build wrapper; generated JavaScript in
`.cache/publisher-tls-qualification` contains code only.

Offline command (no credentials, network or SQL):

```powershell
node scripts/qualify-publisher-tls.mjs --check
```

**Only after separate hosted execution authorization**, run from repository root
in a private PowerShell terminal. Use an independently obtained trusted Supabase
CA outside the repository. The password prompt is hidden; the URL exists only in
process environment/memory, never arguments/history or output. Do not enable
PowerShell tracing or transcript capture. JavaScript/.NET strings cannot promise
memory zeroing. Alternatively, securely prepopulate these same environment inputs
and run the final Node command. The runner requires both flags explicitly false;
it does not load `.env.local` or modify configuration files.

```powershell
$env:SMART_STORAGE_TRANSFERS_ENABLED = 'false'
$env:SMART_STORAGE_DEV_CLOUD_ENABLED = 'false'
$env:SMART_STORAGE_PUBLISHER_CA_FILE = (Resolve-Path -LiteralPath (Read-Host 'Trusted Supabase CA file outside repository')).Path
$publisherSecret = Read-Host 'Restricted publisher password' -AsSecureString
$publisherPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($publisherSecret)
try {
    $publisherPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($publisherPointer)
    $env:SMART_STORAGE_DEV_CLOUD_DATABASE_URL = 'postgresql://ss_dev_cloud_publisher_login.fneuqneqaopkmpeevlqz:' + [Uri]::EscapeDataString($publisherPassword) + '@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'
    node scripts/qualify-publisher-tls.mjs --execute
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($publisherPointer)
    $publisherSecret.Dispose()
    $publisherPassword = $null
    Remove-Item Env:SMART_STORAGE_DEV_CLOUD_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:SMART_STORAGE_PUBLISHER_CA_FILE -ErrorAction SilentlyContinue
}
```

Stop on FAIL without automatic retry. Only sanitized PASS/FAIL and negotiated TLS
version are printed. This is a credentialed SQL-session/Node TLS qualification,
not ordinary Supabase Auth, enrolled-account authorization, publication,
concurrency or production activation qualification. Synthetic claims authenticate
no user. No Storage, migration, signing-key or feature-flag changes are authorized.

Node runner local verification: six focused mocked tests PASS; TypeScript
--noEmit PASS; scoped ESLint with zero warnings PASS; code Prettier PASS.
Offline --check and generated ESM import/SQL-load smoke checks PASS. These tests
exercise refusal and cleanup with synthetic TLS socket objects; no actual Node
TLS handshake or hosted session is claimed. Initial local checks found a module
name resolution collision and a test typing/lint issue; corrected before final
verification. Existing adapter and SQL artifacts remain unchanged.
