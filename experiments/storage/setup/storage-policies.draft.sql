-- REVIEW ONLY. Never a production migration. No SQL was executed in Task 1.4A.
-- Replace the two UUID placeholders and single run marker only after setup approval.
-- Inspect ALL existing policies first: permissive policies combine with OR.
-- Confirm bucket private, provider file_size_limit=8388608, no conflicting UPDATE
-- or anonymous grants. No table/role/grant modification is included here.
-- This ownership draft DOES NOT enforce reserved size, cancellation or TUS count.
BEGIN;
DO $$ BEGIN
  RAISE EXCEPTION 'Draft only: explicit setup approval and review required before removing this guard';
END $$;

CREATE POLICY "p14a_feasibility_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'smart-storage-feasibility'
  AND (SELECT auth.uid()::text) IN ('REPLACE_TEST_USER_A_UUID', 'REPLACE_TEST_USER_B_UUID')
  AND name = ANY (
    CASE WHEN (SELECT auth.uid()::text) = 'REPLACE_TEST_USER_A_UUID' THEN ARRAY[
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/00.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/01.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/02.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/03.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/04.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/05.raw'
    ] ELSE ARRAY[
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/06.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/07.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/08.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/09.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/10.raw',
      'p14b-REPLACE_RUN_ID/' || (SELECT auth.uid()::text) || '/11.raw'
    ] END
  )
);

CREATE POLICY "p14a_feasibility_read" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'smart-storage-feasibility'
  AND (SELECT auth.uid()::text) IN ('REPLACE_TEST_USER_A_UUID', 'REPLACE_TEST_USER_B_UUID')
  AND owner_id = (SELECT auth.uid()::text)
  AND (storage.foldername(name))[1] = 'p14b-REPLACE_RUN_ID'
  AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)
  AND array_length(storage.foldername(name), 1) = 2
  AND storage.filename(name) IN (
    '00.raw', '01.raw', '02.raw', '03.raw', '04.raw', '05.raw',
    '06.raw', '07.raw', '08.raw', '09.raw', '10.raw', '11.raw'
  )
);

CREATE POLICY "p14a_feasibility_delete" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'smart-storage-feasibility'
  AND (SELECT auth.uid()::text) IN ('REPLACE_TEST_USER_A_UUID', 'REPLACE_TEST_USER_B_UUID')
  AND owner_id = (SELECT auth.uid()::text)
  AND (storage.foldername(name))[1] = 'p14b-REPLACE_RUN_ID'
  AND (storage.foldername(name))[2] = (SELECT auth.uid()::text)
  AND array_length(storage.foldername(name), 1) = 2
  AND storage.filename(name) IN (
    '00.raw', '01.raw', '02.raw', '03.raw', '04.raw', '05.raw',
    '06.raw', '07.raw', '08.raw', '09.raw', '10.raw', '11.raw'
  )
);

-- Intentionally no UPDATE policy: upsert/rename/move must not be assumed allowed.
-- No anon/public policy. No owner_id check on INSERT: TUS permission probes may
-- construct prospective rows differently; verify actual owner assignment later.
-- SELECT may also permit owner signing/copy source checks; this is not an
-- operation-aware hard authorization or reservation policy. Signed consumption
-- needs a separate review; avoid admin-created test objects when testing ownership.
ROLLBACK;
