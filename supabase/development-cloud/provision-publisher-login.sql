\set ON_ERROR_STOP on
-- Preparation only. Run as verified project postgres after separate authorization.
-- No password is supplied; role cannot authenticate until manually configured.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' OR current_setting('app.settings.project_ref',true) IS DISTINCT FROM 'fneuqneqaopkmpeevlqz' THEN RAISE EXCEPTION 'Verified project owner required'; END IF;
 IF current_setting('server_version_num')::int<160000 OR current_database()<>'postgres' THEN RAISE EXCEPTION 'Database/version mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ss_dev_cloud_publisher_login') THEN RAISE EXCEPTION 'Login already exists; inspect, do not overwrite'; END IF;
 IF to_regclass('app_private.gateway_accounts') IS NOT NULL THEN RAISE EXCEPTION 'Unexpected gateway schema'; END IF;
 IF (SELECT count(*) FROM app_private.dev_cloud_backup b JOIN pg_catalog.pg_proc p ON p.proname=b.name AND p.pronamespace='public'::regnamespace WHERE b.name IN ('ss_allocate_attempt','ss_begin_attempt_request','ss_finish_attempt_request','ss_record_observation','ss_finalize_verified') AND md5(p.prosrc)=b.installed_hash)<>5 THEN RAISE EXCEPTION 'Installed function drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('ss_allocate_attempt','ss_finish_attempt_request','ss_record_observation','ss_finalize_verified') AND prosrc !~ 'v_(session|attempt|actor)') THEN RAISE EXCEPTION 'Alias correction required'; END IF;
END $$;
CREATE ROLE ss_dev_cloud_publisher_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2 PASSWORD NULL;
GRANT CONNECT ON DATABASE postgres TO ss_dev_cloud_publisher_login;
GRANT ss_dev_cloud_publisher TO ss_dev_cloud_publisher_login WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
-- Shared audit permits only ordinary inherited PUBLIC TEMP; no TEMP grant/revoke.
-- Helper/trigger bodies and owners are pinned; all other restrictions still apply.
\ir publisher-permissions.assert.sql
COMMIT;
