-- Run read-only in Dashboard ONLY after confirming project rrylhvqalsxjnkdkpwde.
-- Both values MUST be false. Any error/unknown/true means STOP. Never reset claims.
BEGIN READ ONLY;
SELECT EXISTS (
 SELECT 1 FROM storage.objects
 WHERE bucket_id = 'smart-storage-gateway-probe'
 AND name = 'practice-roundtrip/20261019/compressed-test-001.bin'
) AS object_exists,
EXISTS (SELECT 1 FROM smart_storage_claims.attempts) AS claim_exists;
ROLLBACK;
