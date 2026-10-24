# Installed development backend: alias correction

Review candidate only, target `fneuqneqaopkmpeevlqz`. No live execution is
authorized by preparing these files. ADR-041 OPEN; production transfers disabled.
No native target was established as authorized for this task. PGlite validation
uses disposable synthetic Auth/Storage schemas, never installed credentials.

`correct-aliases.sql` replaces exactly four functions. `ss_begin_attempt_request`
is checked as a prerequisite but not replaced. Only conflicting PL/pgSQL variable
identifiers change. No predicate, query ordering, lock, evidence check, grant,
account, quota, role, signing key or accounting behavior changes. Updating the
four existing `dev_cloud_backup.installed_hash` entries keeps the original full
package rollback usable; their saved base definitions are retained byte-for-byte.

## Preconditions and operator review

1. Review these generated SQL files and the generator sources. Independently
   identify the actual connection as the development project. A custom project
   setting is an operator assertion, not project discovery. Stop the development
   app and exclude concurrent administrator DDL. Keep both transfer flags false.
2. Use an already authorized administrative session as `postgres`. No role,
   password or credential creation is part of this correction. Only after
   verifying the target, set session `app.settings.project_ref` to the exact
   project reference externally. The correction never sets its own project pin.
3. Check the installed five exact signatures, full `pg_get_functiondef` output,
   owners, ACLs, restricted-role attributes and existing backup definitions and
   hashes against the literal preconditions in the correction. Exact baseline
   evidence is frozen in `tests/fixtures/development-cloud-live-alias-baseline.json`.
   No migration 004–014 is a prerequisite; unexpected gateway schema aborts.
4. After separate execution authorization, run the reviewed transaction once
   using an error-stopping SQL client (`ON_ERROR_STOP` for psql). The script owns
   BEGIN/COMMIT; do not wrap it in another transaction. Any error requires
   ROLLBACK and inspection; do not loosen a guard or automatically retry.

Both correction and rollback enforce five-second lock and fifteen-second
statement timeouts. They lock the existing backup table, validate every function
before changing anything, and repeat full definition/ACL/hash checks afterward.
They accept only the two previously documented allocation ACL variants, and
only postgres plus ss_dev_cloud_publisher EXECUTE for the trusted functions.
Full-definition checks intentionally fail closed on formatting/version drift.
They do not establish hosted Auth helper behavior, provider semantics, effective
PUBLIC privilege closure or TLS connectivity.

## Rollback

Before COMMIT, an error aborts the transaction; explicitly ROLLBACK. No partial
replacement or accounting settlement can remain from that failed transaction.

For an already committed correction, stop the app and keep features disabled.
After separately authorizing rollback and verifying the same target/session pin,
run `rollback-aliases.sql` with error-stop enabled. It requires the exact corrected
definitions, ACLs and backup hashes, then restores the four prior development
definitions and their installed hashes. It preserves grants, enrollment, data,
objects and accounting. Those prior definitions contain the known collisions;
rollback is a compatibility reversal, not a working publication configuration.

`rollback.sql` remains the distinct full development-package rollback. Do not
confuse it with this alias-only reversal. No automatic rollback, reinstall or
activation is proposed.

## Reproducibility and tests

`node scripts/prepare-dev-cloud-package.mjs` reproduces `install.sql`,
`correct-aliases.sql` and `rollback-aliases.sql`. Sources are the unchanged base
002/003 definitions, existing template/policies, generator variable-renaming map,
correction builder, immutable predecessor fixture and verified live JSON snapshot. The install template now
contains the historical project-pin statement formerly present only in generated
install.sql, repairing its pre-existing reproducibility mismatch. That preserves
fresh-install behavior; the narrow correction still requires an external pin.

Focused tests run with `plpgsql.variable_conflict=error`. They prove token-level
identifier-only equivalence to the prior five definitions, fifth-RPC identity,
exact correction/rollback restoration and ACL preservation for both allocation
ACL variants. Drift cases cover wrong project, definition, ACL, backup hash and
reapplication, checking atomic rejection. Functional cases cover real reservation
and allocation, owner/role/enrollment denial, quota bounds, replay fencing,
ambiguous-request retained liability, missing object evidence, manifest/block
integrity rejection, successful/idempotent finalization, ready files, one-time
accounting settlement and owner-only dashboard listing. Existing application
tests retain independent byte readback, SHA-256 and publication-recovery coverage.

## Live reconciliation — 2026-10-23

Read-only catalog inspection of the specified project verified all five complete
definitions, owners, ACLs, saved backup definitions and installed hashes. The old
generator normalized the predecessor fixture to LF; deployed function bodies use
CRLF. Normalizing only those live body line endings reproduces the predecessor
exactly. Saved base definitions already use LF and match exactly. Thus body hashes
and complete-definition preconditions differed despite equivalent SQL semantics.

The generator now consumes the captured live baseline, verifies its hashes and
full predecessor/base equivalence, and preserves CRLF body bytes in both directions.
SQL escape literals preserve exact bytes independently of client newline conversion.
It still derives changes from the existing variable-renaming transformation, rather
than editing hash literals. The fifth definition remains untouched. All original
drift, owner, role, ACL, project-pin and transactional guards remain enforced.

Hosted `auth.jwt()` prefers `request.jwt.claim` over `request.jwt.claims`;
`auth.uid()` prefers `request.jwt.claim.sub`. The direct adapter previously omitted
clearing the first setting. It now clears both locally before setting verified
claims. Captured hosted helpers replace simplified helpers in the disposable
publication test. The unchanged owner helper accepts only an enabled subject,
nonanonymous context and authenticated/publisher role; publisher RPCs additionally
require the exact publisher role. A bare direct login remains unauthorized.
Claims are trusted server impersonation after ordinary session verification, not
JWT signature verification by PostgreSQL. No authentication check was bypassed.

The dedicated login is absent in the live catalog. Therefore scripts are prepared
for separately authorized alias deployment, but direct LOGIN/membership/TLS and
effective privilege closure remain activation gates. No credential was inspected
or provisioned. Native PostgreSQL and real Storage execution remain unverified.
ADR-041 remains OPEN; production transfers remain disabled. No live writes,
cloud transfers, migration 004–014 execution or signing-key changes occurred.

Reconciled verification: the four focused Vitest suites passed 36/36 with
`--no-file-parallelism`, including live-byte correction/rollback, drift rejection,
both allocation ACL variants, captured hosted Auth helpers, legacy-claim precedence
and local clearing, role/owner denial, and successful/idempotent finalization.
TypeScript `--noEmit`, scoped ESLint `--max-warnings=0` and scoped Prettier checks
passed. Generator reproducibility passed. Read-only catalog checks also confirmed
one signature per function, five backup rows, expected restricted publisher role
attributes and absence of `app_private.gateway_accounts`.

Outcome: ready for separately authorized alias-script deployment against the
verified baseline, with mandatory execution-time guards; not runtime activation.
Stop here. The next task requires separate live deployment authorization.

Executed verification (2026-10-23): node node_modules/vitest/vitest.mjs run --no-file-parallelism tests/unit/development-publisher-postgres.test.ts tests/unit/development-cloud-package.test.ts tests/unit/development-cloud-install.test.ts tests/unit/development-cloud.test.ts - 36/36 PASS. TypeScript --noEmit PASS. Scoped ESLint --max-warnings=0 and Prettier --check for the two generator modules and two changed test files PASS. Generator reproducibility checks all three output SQL files. Native execution unverified; no authorized native target was established.
