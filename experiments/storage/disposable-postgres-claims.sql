-- Disposable project rrylhvqalsxjnkdkpwde ONLY. Apply once, as one migration.
-- Only new claim objects are created; existing objects and schema ACLs unchanged.
-- Caller must confirm Dashboard project: a SQL literal is not project proof.
BEGIN;
DO $$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'run as the confirmed disposable project Dashboard postgres role';
  END IF;
END;
$$;
-- Keep new objects owned by this existing deployment role. PostgreSQL 16+
-- non-superuser role creation leaves a bootstrap-granted ADMIN membership that
-- the creator cannot revoke. No new role, membership, ownership transfer or
-- temporary CREATE grant is needed; existing schema ACLs remain untouched.
CREATE SCHEMA smart_storage_claims AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA smart_storage_claims FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE smart_storage_claims.attempts (
  project text NOT NULL CHECK (project = 'rrylhvqalsxjnkdkpwde'),
  bucket text NOT NULL CHECK (bucket = 'smart-storage-gateway-probe'),
  object_key text NOT NULL CHECK (object_key = 'practice-roundtrip/20261019/compressed-test-001.bin'),
  operation text NOT NULL CHECK (operation IN ('upload', 'download')),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project, bucket, object_key, operation)
);
ALTER TABLE smart_storage_claims.attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smart_storage_claims.attempts FROM PUBLIC, anon, authenticated, service_role;
-- No caller policy. Owner postgres can inspect; owner RLS bypass is intentional.

CREATE FUNCTION smart_storage_claims.deny_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'claims are permanent'; END;
$$;
REVOKE ALL ON FUNCTION smart_storage_claims.deny_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER permanent_claims BEFORE UPDATE OR DELETE OR TRUNCATE
ON smart_storage_claims.attempts FOR EACH STATEMENT
EXECUTE FUNCTION smart_storage_claims.deny_mutation();

-- SECURITY DEFINER runs as postgres, not the calling authenticated role.
-- This is privileged code: fixed target, fully qualified names, no dynamic SQL,
-- identity check on every call; never add arbitrary caller-controlled SQL.
CREATE FUNCTION public.smart_storage_claim_once(p_operation text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '5s'
SET statement_timeout = '8s'
AS $$
DECLARE consumed boolean;
BEGIN
  -- Transaction-local, not a function SET option: it must remain on after the
  -- function returns and until PostgREST commits the enclosing transaction.
  PERFORM pg_catalog.set_config('synchronous_commit', 'on', true);
  IF auth.uid() IS DISTINCT FROM '310d0ec8-84ca-423a-b646-0480a20edc09'::uuid
     OR p_operation IS NULL OR p_operation NOT IN ('upload', 'download') THEN
    RAISE EXCEPTION 'claim denied' USING ERRCODE = '42501';
  END IF;
  IF p_operation = 'download' AND NOT EXISTS (
    SELECT 1 FROM smart_storage_claims.attempts WHERE operation = 'upload'
  ) THEN
    RAISE EXCEPTION 'upload claim required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO smart_storage_claims.attempts(project, bucket, object_key, operation)
  VALUES ('rrylhvqalsxjnkdkpwde', 'smart-storage-gateway-probe',
          'practice-roundtrip/20261019/compressed-test-001.bin', p_operation)
  ON CONFLICT DO NOTHING RETURNING true INTO consumed;
  RETURN coalesce(consumed, false);
END;
$$;
REVOKE ALL ON FUNCTION public.smart_storage_claim_once(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.smart_storage_claim_once(text) TO authenticated;
-- Schema reload takes effect on COMMIT. A SQL/RPC rollback still rolls back a
-- claim: effective PostgREST commit-before-response remains a qualification gate.
-- Admin DROP/trigger disable/backup restore remain outside this DDL's protection.
NOTIFY pgrst, 'reload schema';
COMMIT;
