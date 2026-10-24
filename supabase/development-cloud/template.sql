-- REVIEW ONLY: explicitly pinned deployment session; never part of migration sweep.
BEGIN;
-- Operator must independently verify the connection target before deployment.
SELECT set_config('app.settings.project_ref','fneuqneqaopkmpeevlqz',true);
DO $$ BEGIN
 IF current_setting('app.settings.project_ref',true) IS DISTINCT FROM 'fneuqneqaopkmpeevlqz' THEN RAISE EXCEPTION 'Verified project pin required'; END IF;
 IF to_regclass('app_private.gateway_accounts') IS NOT NULL THEN RAISE EXCEPTION 'Unexpected gateway schema'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND policyname NOT LIKE 'ss_dev_%') THEN RAISE EXCEPTION 'Unexpected Storage policies'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS app_private.dev_cloud_backup(name text PRIMARY KEY, definition text NOT NULL, installed_hash text);
CREATE TABLE IF NOT EXISTS app_private.dev_cloud_accounts(owner_id uuid PRIMARY KEY REFERENCES auth.users(id),enabled boolean NOT NULL DEFAULT false);
REVOKE ALL ON app_private.dev_cloud_backup,app_private.dev_cloud_accounts FROM PUBLIC,anon,authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher') THEN
  IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup) OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit)) THEN RAISE EXCEPTION 'Unexpected existing role'; END IF;
 ELSE
  CREATE ROLE ss_dev_cloud_publisher NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
GRANT ss_dev_cloud_publisher TO authenticator;
GRANT USAGE ON SCHEMA public TO ss_dev_cloud_publisher;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('smart-storage-dev-cloud','smart-storage-dev-cloud',false,6291456,ARRAY['application/octet-stream']) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='smart-storage-dev-cloud' AND name=id AND NOT public AND file_size_limit=6291456 AND allowed_mime_types=ARRAY['application/octet-stream']) THEN RAISE EXCEPTION 'Bucket mismatch'; END IF;
END $$;
CREATE OR REPLACE FUNCTION app_private.dev_cloud_owner() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE a uuid:=auth.uid(); BEGIN
 IF a IS NULL OR auth.jwt()->>'role' IS NULL OR auth.jwt()->>'role' NOT IN ('authenticated','ss_dev_cloud_publisher') OR coalesce((auth.jwt()->>'is_anonymous')::boolean,false) OR NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_accounts WHERE owner_id=a AND enabled) THEN RAISE EXCEPTION 'DEV_ACCOUNT_DISABLED'; END IF;
 RETURN a;
END $$;
REVOKE ALL ON FUNCTION app_private.dev_cloud_owner() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.dev_cloud_owner() TO authenticated;
