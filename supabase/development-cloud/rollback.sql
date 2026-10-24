-- First stop localhost app, disable feature and expire/revoke issuer credentials.
BEGIN;
UPDATE app_private.dev_cloud_accounts SET enabled=false;
REVOKE ss_dev_cloud_publisher FROM authenticator;
DO $$ DECLARE r record; p oid; BEGIN
 FOR r IN SELECT * FROM app_private.dev_cloud_backup LOOP
  SELECT oid INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=r.name;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p) IS DISTINCT FROM r.installed_hash THEN RAISE EXCEPTION 'Contract drift'; END IF;
  EXECUTE r.definition;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM ss_dev_cloud_publisher',p::regprocedure);
  IF r.name<>'ss_allocate_attempt' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',p::regprocedure); END IF;
 END LOOP;
END $$;
DROP POLICY IF EXISTS ss_dev_bucket_read ON storage.buckets;
DROP POLICY IF EXISTS ss_dev_object_insert ON storage.objects;
DROP POLICY IF EXISTS ss_dev_object_read ON storage.objects;
-- Retain objects, bucket, accounting holds, enrolled rows, backups and NOLOGIN role.
-- Never delete cloud objects through SQL or infer capacity release from rollback.
COMMIT;
