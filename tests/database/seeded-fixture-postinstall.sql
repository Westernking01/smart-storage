-- Focused local verification only. No registration, fixtures or configuration writes.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$ BEGIN
 ASSERT current_database()='smart_storage_gateway_test';
 ASSERT inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432;
 ASSERT current_setting('server_version_num')::int BETWEEN 170000 AND 179999;
 ASSERT current_user='postgres';
END $$;
SELECT 'tables_exist_and_rls' AS check,
 count(*)=2 AND bool_and(c.relrowsecurity AND c.relowner='postgres'::regrole) AS pass
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='app_private' AND c.relkind='r'
 AND c.relname IN ('seeded_fixture_registrations','seeded_fixture_receipts');
SELECT 'schema_owner' AS check, nspowner='postgres'::regrole AS pass
 FROM pg_namespace WHERE nspname='app_private';
SELECT 'functions_owner_definer_search_path' AS check,
 count(*)=3 AND bool_and(proowner='postgres'::regrole AND prosecdef
 AND proconfig @> ARRAY['search_path=""']) AS pass
 FROM pg_proc WHERE oid IN (
 'public.ss_seeded_fixture_register_v1(text,timestamptz)'::regprocedure,
 'public.ss_seeded_fixture_resolve_v1(uuid,uuid)'::regprocedure,
 'public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb)'::regprocedure);
SELECT 'new_table_acl_only_owner' AS check, NOT EXISTS (
 SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 WHERE c.oid IN ('app_private.seeded_fixture_registrations'::regclass,'app_private.seeded_fixture_receipts'::regclass)
 AND a.grantee<>c.relowner) AS pass;
SELECT 'new_function_acl_exact' AS check, NOT EXISTS (
 SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid IN ('public.ss_seeded_fixture_register_v1(text,timestamptz)'::regprocedure,
 'public.ss_seeded_fixture_resolve_v1(uuid,uuid)'::regprocedure,'public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb)'::regprocedure)
 AND a.grantee<>p.proowner AND NOT (p.proname<>'ss_seeded_fixture_register_v1'
 AND a.grantee='ss_gateway_observer'::regrole AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) AS pass;
SELECT 'no_registration_or_receipts' AS check,
 NOT EXISTS(SELECT FROM app_private.seeded_fixture_registrations)
 AND NOT EXISTS(SELECT FROM app_private.seeded_fixture_receipts) AS pass;
SELECT r.rolname, 'role_attributes' AS check,
 NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
 AND rolcanlogin=(r.rolname='ss_gateway_observer_runtime_test') AS pass
 FROM pg_roles r WHERE rolname IN ('ss_gateway_observer','ss_gateway_observer_runtime_test');
SELECT 'observer_membership_exact' AS check, count(*)=1 AND bool_and(
 roleid='ss_gateway_observer'::regrole AND NOT admin_option AND NOT inherit_option AND set_option) AS pass
 FROM pg_auth_members WHERE member='ss_gateway_observer_runtime_test'::regrole;
SELECT r.rolname, 'no_direct_table_or_column_access' AS check, NOT EXISTS (
 SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m','f')
 AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS pass
 FROM pg_roles r WHERE rolname IN ('ss_gateway_observer','ss_gateway_observer_runtime_test');
SELECT r.rolname, p.proname, has_function_privilege(r.oid,p.oid,'EXECUTE') AS executable
 FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE r.rolname IN ('ss_gateway_observer','ss_gateway_observer_runtime_test')
 AND n.nspname='public' AND (p.proname LIKE 'ss_gateway_%' OR p.proname LIKE 'ss_seeded_fixture_%')
 ORDER BY r.rolname,p.proname;
ROLLBACK;
