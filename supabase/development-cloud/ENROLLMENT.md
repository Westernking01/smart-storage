# Enrollment extension — offline candidate, 2026-10-23

Update: the isolated Auth-bound probe is now prepared in
`postgresPublisherIdentityProbe` in the existing publisher adapter module.
It is not selected by any route/runtime and this enrollment SQL is still NOT
DEPLOYED. It requires the prepared function; absence/error fails closed without
fallback to a publication RPC. See the latest qualification/handoff entry.

NOT DEPLOYED. No hosted requests, SQL, credentials or live permission changes.
Both cloud-transfer flags remain false. Runtime dormant; ADR-041 OPEN.
Design: [review and trust boundary](../../docs/development-enrollment-verification-design.md).

Files:

- `enrollment-function.sql`: authoritative source fragment; never apply alone.
  Zero arguments, boolean, STABLE SECURITY DEFINER owned by existing postgres;
  empty search_path; fully qualified reads of enrollment and existing ordinary
  Auth-user conditions. Requires dedicated session LOGIN, publisher role, read-only
  transaction, canonical three-field claims and no legacy claims. Malformed or
  ineligible context returns false. Unexpected database failures propagate.
- `install-enrollment.sql`: bounded transaction, pinned operator/project and no
  active publisher connections; strict original baseline assertion, absent-name
  guard, creation/ACL, then strict enrollment assertion. No CREATE OR REPLACE.
  Default ACL leakage to an unexpected role aborts the whole install.
- `publisher-enrollment-permissions.assert.sql`: generated original closure plus
  exactly one function, with exact owner/language/signature/return/volatility/
  search_path/body hash/ACL checks. Original helper bodies/pins are unchanged.
- `publisher-enrollment-preflight.readonly.sql`: explicit preflight variant using
  the new assertion. Preserves synthetic-context-only behavior, ROLLBACK and
  cleanup checks; it does NOT call the enrollment function or verify a real user.
- `rollback-enrollment.sql`: same operator/project/drained-pool guards, exact
  enrollment audit, revoke one grant, DROP exact function without CASCADE, original
  baseline audit, COMMIT. Drift/dependencies abort and preserve the extension.

Deployment needs separate authorization: confirmed development project, qualified
installed baseline/LOGIN, stopped dedicated pool, reviewed SQL and ordinary Auth
columns matching `enroll-account.sql`. Function owner uses existing postgres
privileges; no new role, table/column grants, private-schema access or RLS change.
EXECUTE is granted only to the publisher, never the LOGIN or browser roles.

The original provisioning, preflight and LOGIN rollback scripts remain unchanged
and reject this fifth routine. Use the explicit enrollment preflight while the
extension exists. Remove the extension FIRST before original LOGIN rollback or
full `rollback.sql`; do not insert it into `dev_cloud_backup` or replay provisioning.
No alternative LOGIN-removal script is supplied. Rollback retains all enrollment,
Auth, accounting and Storage records. Reinstallation after reviewed removal uses
the original baseline. All SQL execution still needs separate authorization.

Identity/context probe compatibility: the new capability is a fixed boolean
SELECT usable inside BEGIN READ ONLY after Auth-only verification before and
after checkout. Keep server-generated local claims, fixed role, dedicated pool,
DISCARD ALL, unconditional ROLLBACK, error masking and destruction on uncertain
cleanup. The isolated probe now exists, but routes and RPC dispatch are unchanged.
The existing publisher RPC allowlist remains four mutating operations; this
function is deliberately not available through `trusted()`.

Claims remain settings a LOGIN holder can forge. SQL cannot distinguish a forged
canonical enrolled subject from the same context set after real Auth verification.
Offline tests demonstrate this boundary rather than claiming SQL authenticates
JWTs. Keep credentials server-only and allow no caller-controlled SQL/context.
Enrollment evidence is snapshot-scoped, not permission for later publication.

Offline verification commands:

```text
node scripts/generate-development-enrollment.mjs --check
node node_modules/vitest/vitest.mjs run --no-file-parallelism tests/unit/development-enrollment.test.ts tests/unit/development-publisher-activation.test.ts tests/unit/development-user-verifier.test.ts tests/unit/development-publisher-runtime-qualification.test.ts
node scripts/test-development-enrollment-postgres17.mjs
node node_modules/typescript/bin/tsc --noEmit
```

Focused run: 4 files, 37/37 PASS. Shared enrollment matrix also PASS on native
disposable loopback PostgreSQL 17, non-superuser postgres setup and a real local
restricted LOGIN for preflight. Native fixture bootstrap simulates identities for
the remaining cases; no hosted/TLS/Auth qualification is claimed. Disposable
clusters are stopped on success/failure; evidence directories are retained.
Initial failed runs exposed fixture ordering/session-switch/temp cleanup issues;
these were fixed without changing function authorization or relaxing assertions.

Coverage: enabled, disabled, unenrolled, anonymous, deleted, unconfirmed and wrong
ordinary role; malformed/missing/extra/legacy claims; wrong LOGIN/publisher role;
read-write denial; A/B/A reuse, hostile temp names, denied direct/helper reads;
wrong project/default-ACL leakage; PUBLIC/ordinary/grant-option/column grants;
overload/body/volatility/search_path drift; rollback refusal on dependencies and
active native LOGIN; extension removal and original LOGIN rollback compatibility.
Scoped TypeScript, ESLint and formatting results are recorded in the handoff.

Next: review the extension deployment and rollback package for separate authorization.
Live deployment, real Auth/enrollment evidence and hosted read-only qualification
remain separately authorized steps. No upload/download/publication is authorized.
