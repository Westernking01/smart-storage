# Phase 2.14E local PostgreSQL evidence

Executed on 2026-10-16 against `127.0.0.1:5432`, PostgreSQL 17.11.
Database: `smart_storage_gateway_test`. No Supabase/provider operations.

The bootstrap verifies database/role absence, built-ins and plpgsql, then creates
the database, three restricted compatibility roles and database-local synthetic
Auth helpers. Unchanged migrations 001–007 create the other four roles; their
omitted role attributes have PostgreSQL defaults matching the approved explicit
NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS definitions.
No memberships were added. All seven restricted attribute sets were read back.

Commands executed:

```powershell
node --check tests/database/gateway-214e-local.mjs
node tests/database/gateway-214e-local.mjs
node --check tests/database/gateway-214e-races.mjs
node tests/database/gateway-214e-races.mjs
node tests/database/gateway-214e-races.mjs --resume
node tests/database/gateway-214e-verify.mjs
```

Bootstrap is deliberately one-shot: an existing target database or any role
collision stops execution. Do not rerun it against the retained environment.
Authentication sets PGPASSFILE only in child psql environments; none of these
scripts reads the password file or application environment files.

All seven migrations and three existing serial contract scripts passed.
Twelve overlapping transaction cases cover the ten requested requirements:

| Requested coverage          | Concurrent case                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Active-stream capacity      | Competing claims, one admitted                                                      |
| Duplicate claim             | One durable request and one byte charge                                             |
| One-time dispatch           | First grant commits, second rejects                                                 |
| Fencing                     | Epoch update fences waiting dispatch                                                |
| Rollback/lease safety       | Rolled-back claim admits waiter; expiry retains occupancy; one cleanup lease winner |
| Cross-account authorization | Explicit row barrier, then forbidden foreign claim                                  |
| Immutable evidence          | Conflicting receipt operation cannot replace first evidence                         |
| Manifest/temporary capacity | Competing generalized writers share one capacity limit                              |
| Membership/cleanup          | Cleanup fencing rejects waiting resource registration                               |
| Exactly-once settlement     | Duplicate concurrent settlement yields one release/event                            |

Each case records distinct worker A, worker B and observer C PIDs, READ COMMITTED,
and B's observed PostgreSQL lock wait with A in pg_blocking_pids before releasing
A. Worker RPC calls use restricted SET LOCAL ROLE. Migration ownership and
synthetic evidence imports use postgres. Cross-account denial uses an explicit
row barrier before the denied RPC; its authorization check itself fails before
locking. This is not a claim that a forbidden call takes owner locks.

Five harness/fixture failures are retained in results: initial missing shared
lease barrier, resume namespace collision, duplicate protocol fixture identity,
attempted reuse of an immutable manifest path, and an unscoped fixture assertion.
Corrected cases used fresh fixture namespaces without deleting previous rows.
Application constraints, RLS, grants and migrations were not weakened.

Security verification passed owner and cross-owner SELECT RLS, private import
denials, restricted gateway execution and absence of memberships. Public
application and gateway tables have RLS. Existing private account_policy lacks
RLS but denies SELECT/INSERT/UPDATE/DELETE to all seven runtime roles; no schema
change was made. Synthetic helper/certificate tables are test-only objects.

`gateway-214e-results.json` records migration hashes, role attributes, serial and
concurrent outcomes, failures and security checks. `gateway-214e-inventory.json`
lists schemas, relations (including indexes), function signatures/owners/settings,
triggers, policies and fixture counts. Retained: 90 synthetic users, 180 files,
180 sessions across original and fresh scenario namespaces through 44. Database,
all seven roles and all fixtures remain for inspection. No automatic teardown;
later cleanup must check cross-database role dependencies and be separately
authorized. Do not run broad DROP OWNED/CASCADE operations.

Synthetic claims and administrator-imported certificates prove relational
enforcement only. They do not prove hosted Auth/JWT verification, real provider
identity/hash, complete discovery, writer termination/drain or authoritative
physical absence. ADR-041 remains unresolved; cloud transfers remain disabled.
