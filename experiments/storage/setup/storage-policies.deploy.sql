-- DEVELOPMENT-ONLY DEPLOYMENT CANDIDATE: Task 1.4A.6.
-- Execution requires separate explicit user approval; NOT AUTHORIZED YET.
-- Scope: exactly four reviewed storage.objects policies for the verified
-- private smart-storage-feasibility bucket and fixed twelve-path experiment.
-- Derived from unchanged validated storage-policies.review.sql.
-- Only review guard removed, terminal ROLLBACK changed to COMMIT, header updated.
-- Use one transaction with an approved owner-capable SQL executor; do not bypass
-- read-only MCP. No grants, settings, objects, Auth changes or provider tests.
-- TUS runtime/HEAD ownership and quota release blockers remain unverified.
BEGIN;

-- Fail closed rather than drop/replace policies; a second deployment must stop.
-- Before approved execution also reconfirm project identity, API schema exposure,
-- complete grants and exact helper semantics. Never execute this to parse SQL.
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'smart-storage-feasibility'
    AND name = 'smart-storage-feasibility' AND public = false
    AND file_size_limit = 8388608
    AND allowed_mime_types = ARRAY['application/octet-stream']::text[]) THEN
    RAISE EXCEPTION 'Bucket configuration mismatch';
  END IF;
  IF (SELECT count(*) FROM auth.users WHERE
    (id = '7aaa8834-54ec-4f57-ae96-080928d8f74f'::uuid AND email = 'smart-storage-user-a@example.invalid') OR
    (id = '4af63360-f59f-48d7-a745-49cb4339f26a'::uuid AND email = 'smart-storage-user-b@example.invalid')) <> 2 THEN
    RAISE EXCEPTION 'Test identity mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN ('7aaa8834-54ec-4f57-ae96-080928d8f74f'::uuid, '4af63360-f59f-48d7-a745-49cb4339f26a'::uuid)
    AND (role IS DISTINCT FROM 'authenticated' OR email_confirmed_at IS NULL)) THEN
    RAISE EXCEPTION 'Test identity status mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage'
    AND tablename IN ('objects', 'buckets')) THEN
    RAISE EXCEPTION 'Policies changed or already deployed: separate review required';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname IN ('objects', 'buckets')
    AND c.relrowsecurity AND NOT c.relforcerowsecurity
    AND pg_get_userbyid(c.relowner) = 'supabase_storage_admin') <> 2 THEN
    RAISE EXCEPTION 'Storage RLS/ownership changed';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'smart-storage-feasibility') THEN
    RAISE EXCEPTION 'Unexpected existing objects: reconcile ledger before deployment';
  END IF;
  IF to_regprocedure('storage.allow_any_operation(text[])') IS NULL THEN
    RAISE EXCEPTION 'Required operation helper unavailable';
  END IF;
  IF to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Expected authenticated role unavailable';
  END IF;
  IF NOT has_function_privilege('authenticated',
    'storage.allow_any_operation(text[])', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE')
    OR NOT has_schema_privilege('authenticated', 'auth', 'USAGE') THEN
    RAISE EXCEPTION 'Policy helper access changed';
  END IF;
END;
$preflight$;

CREATE POLICY "p14a3_feasibility_insert" ON storage.objects
AS PERMISSIVE FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'smart-storage-feasibility'
  AND (
    ((SELECT auth.uid()) = '7aaa8834-54ec-4f57-ae96-080928d8f74f'::uuid AND name = ANY (ARRAY[
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/00.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/01.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/02.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/03.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/04.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/05.raw'
    ]::text[]))
    OR
    ((SELECT auth.uid()) = '4af63360-f59f-48d7-a745-49cb4339f26a'::uuid AND name = ANY (ARRAY[
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/06.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/07.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/08.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/09.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/10.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/11.raw'
    ]::text[]))
  )
  AND storage.allow_any_operation(ARRAY[
    'object.upload', 'tus.upload.create', 'tus.upload.part', 'tus.upload.get'
  ]::text[])
);

CREATE POLICY "p14a3_feasibility_select" ON storage.objects
AS PERMISSIVE FOR SELECT TO authenticated
USING (
  bucket_id = 'smart-storage-feasibility'
  AND (
    ((SELECT auth.uid()) = '7aaa8834-54ec-4f57-ae96-080928d8f74f'::uuid AND name = ANY (ARRAY[
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/00.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/01.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/02.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/03.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/04.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/05.raw'
    ]::text[]))
    OR
    ((SELECT auth.uid()) = '4af63360-f59f-48d7-a745-49cb4339f26a'::uuid AND name = ANY (ARRAY[
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/06.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/07.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/08.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/09.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/10.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/11.raw'
    ]::text[]))
  )
  AND owner_id = (SELECT auth.uid()::text)
  AND storage.allow_any_operation(ARRAY[
    -- INSERT RETURNING may also require SELECT under the upload context.
    -- Owner metadata must already be provider-populated for that probe to pass.
    'object.upload',
    'object.get_authenticated', 'object.get_authenticated_info',
    'object.head_authenticated_info', 'object.list', 'object.list_v2',
    'object.delete', 'object.delete_many',
    'tus.upload.create', 'tus.upload.part', 'tus.upload.get'
  ]::text[])
);

CREATE POLICY "p14a3_feasibility_delete" ON storage.objects
AS PERMISSIVE FOR DELETE TO authenticated
USING (
  bucket_id = 'smart-storage-feasibility'
  AND (
    ((SELECT auth.uid()) = '7aaa8834-54ec-4f57-ae96-080928d8f74f'::uuid AND name = ANY (ARRAY[
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/00.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/01.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/02.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/03.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/04.raw',
      'p14b-20261011-c40e8e03/7aaa8834-54ec-4f57-ae96-080928d8f74f/05.raw'
    ]::text[]))
    OR
    ((SELECT auth.uid()) = '4af63360-f59f-48d7-a745-49cb4339f26a'::uuid AND name = ANY (ARRAY[
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/06.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/07.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/08.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/09.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/10.raw',
      'p14b-20261011-c40e8e03/4af63360-f59f-48d7-a745-49cb4339f26a/11.raw'
    ]::text[]))
  )
  AND owner_id = (SELECT auth.uid()::text)
  AND storage.allow_any_operation(ARRAY['object.delete', 'object.delete_many']::text[])
);

-- Restrictive defense: denies UPDATE from or into this bucket for ordinary
-- RLS-subject roles even if a future permissive UPDATE policy is introduced.
-- It grants nothing elsewhere; administrators/table owners can still bypass RLS.
CREATE POLICY "p14a3_feasibility_no_update" ON storage.objects
AS RESTRICTIVE FOR UPDATE TO PUBLIC
USING (bucket_id <> 'smart-storage-feasibility')
WITH CHECK (bucket_id <> 'smart-storage-feasibility');

-- Rollback after a separately approved deployment: first record matching policy
-- definitions, stop new attempts and reconcile active TUS resources/capabilities.
-- In an explicitly approved transaction, drop ONLY these four named policies:
-- DROP POLICY "p14a3_feasibility_insert" ON storage.objects;
-- DROP POLICY "p14a3_feasibility_select" ON storage.objects;
-- DROP POLICY "p14a3_feasibility_delete" ON storage.objects;
-- DROP POLICY "p14a3_feasibility_no_update" ON storage.objects;
-- Do not drop unrelated policies, bucket, users or object metadata. Policy removal
-- can prevent ordinary-user cleanup; reconcile exact ledger objects first.
-- Removing policies is not proven revocation of existing signed/TUS resources.
COMMIT;

