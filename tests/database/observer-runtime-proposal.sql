-- REVIEW ONLY. Never run without explicit cluster-role approval and catalog preflight.
-- Dedicated identity; password is set interactively by the user, never in SQL/source.
BEGIN;
CREATE ROLE ss_gateway_observer_runtime_test LOGIN NOSUPERUSER NOCREATEDB
 NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT ss_gateway_observer TO ss_gateway_observer_runtime_test
 WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT CONNECT ON DATABASE smart_storage_gateway_test TO ss_gateway_observer_runtime_test;
ALTER ROLE ss_gateway_observer_runtime_test IN DATABASE smart_storage_gateway_test
 SET search_path = '';
-- No private-schema/table grants; no executor/finalizer/cleaner membership.
-- Existing target PUBLIC CONNECT/TEMP revocation must be verified, not broadened.
ROLLBACK; -- Review guard: activation requires separately reviewed COMMIT.

-- Proposed HBA additions, BEFORE existing broad allows (separate approval/reload):
-- host smart_storage_gateway_test ss_gateway_observer_runtime_test 127.0.0.1/32 scram-sha-256
-- host all ss_gateway_observer_runtime_test 0.0.0.0/0 reject
-- host all ss_gateway_observer_runtime_test ::0/0 reject
-- local all ss_gateway_observer_runtime_test reject
-- Verify pg_hba_file_rules order/errors, then independent positive/negative login.
-- Use unique interactive SCRAM password and external restricted passfile/pool only.
-- Never reuse postgres/executor credentials. No secret read or env fallback.
