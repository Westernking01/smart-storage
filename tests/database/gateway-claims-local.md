# Local gateway claim verification (Phase 2.12A)

Run from the project root. These scripts do not read `.env.local`, use the Supabase SDK, or contact a provider. Migrations 001–003 are read unchanged.

```powershell
node tests/database/gateway-claims-local.mjs --pglite
```

This uses the installed PGlite dependency to execute all four migrations and SQL assertions. It validates PostgreSQL syntax and serial behavior, including restricted execution, ownership, replay, exact length, account capacity, one-time dispatch, immutable identity, stale epochs, rollback, expiry without release and zero-byte occupancy. It does **not** verify races between independent PostgreSQL connections.

For concurrency verification, use an **isolated disposable local PostgreSQL cluster**, with `psql` on PATH and an administrator capable of creating roles and bypassing RLS. Create a fresh empty database named `ss_gateway_212a_test_<unique_suffix>` yourself, then run:

```powershell
node tests/database/gateway-claims-local.mjs --postgres ss_gateway_212a_test_run1 5432 postgres
```

Only `127.0.0.1` is accepted; hosted URLs and arbitrary database names cannot be supplied. Connection service/host overrides are cleared. The runner installs minimal local Auth stubs, roles, migrations and synthetic fixtures in the empty database. Migration 004 creates a cluster-wide `ss_gateway_executor` NOLOGIN role, so use a fresh isolated cluster where it does not already exist. No existing project database is needed. The script leaves the database and roles available for inspection and performs no teardown.

Two independent `psql` backends compete across separate sessions belonging to the same account. A third connection observes the second backend waiting on a PostgreSQL lock before allowing the first backend to commit or roll back. Assertions require exactly one surviving claim, capacity rejection after commit, admission after rollback, and no rolled-back attempted-byte increment. No timing-only race or JavaScript SQL mock is used. Failures/timeouts stop the run; use a fresh disposable cluster for another run.

The account sidecar has no migration seed and defaults to zero streams. Only synthetic fixtures configure capacity and a local test bucket name; no bucket is created. Runtime provisioning, gateway login membership, adapters, evidence-based release, provider capabilities, full-block boundary/fault matrices and broader claim/cancel/dispatch races remain separate work. Byte and epoch results use decimal strings; a future core adapter must check safe-integer conversion and retain request/executor/generation context per invocation.
