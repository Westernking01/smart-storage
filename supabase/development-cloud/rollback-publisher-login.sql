\set ON_ERROR_STOP on
-- Stop the dedicated pool first. No DROP OWNED, CASCADE or connection termination.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' OR current_setting('app.settings.project_ref',true) IS DISTINCT FROM 'fneuqneqaopkmpeevlqz' THEN RAISE EXCEPTION 'Verified project owner required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename='ss_dev_cloud_publisher_login') THEN RAISE EXCEPTION 'Stop publisher connections first'; END IF;
END $$;
-- Shared audit permits only ordinary inherited PUBLIC TEMP; no TEMP grant/revoke.
-- Helper/trigger bodies and owners are pinned; all other restrictions still apply.
\ir publisher-permissions.assert.sql
ALTER ROLE ss_dev_cloud_publisher_login NOLOGIN PASSWORD NULL;
REVOKE ss_dev_cloud_publisher FROM ss_dev_cloud_publisher_login;
REVOKE CONNECT ON DATABASE postgres FROM ss_dev_cloud_publisher_login;
DROP ROLE ss_dev_cloud_publisher_login;
COMMIT;
