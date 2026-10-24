-- Run ONLY in confirmed Dashboard project rrylhvqalsxjnkdkpwde after migration.
-- Does not invoke the claim RPC, consume an operation, or touch object metadata.
BEGIN READ ONLY;
SELECT clock_timestamp() AS observed_at, current_database(), session_user,
       current_user, current_setting('server_version') AS server_version,
       current_setting('fsync') AS fsync,
       current_setting('full_page_writes') AS full_page_writes,
       current_setting('synchronous_commit') AS session_synchronous_commit;
SELECT n.nspname, c.relname, c.relpersistence, c.relrowsecurity,
       pg_get_userbyid(c.relowner) AS owner, c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'smart_storage_claims';
SELECT project, bucket, object_key, operation, claimed_at
FROM smart_storage_claims.attempts ORDER BY operation;
SELECT p.oid::regprocedure AS signature, p.prosecdef, p.proconfig, p.proacl,
       pg_get_userbyid(p.proowner) AS owner, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'smart_storage_claims'
   OR (n.nspname = 'public' AND p.proname = 'smart_storage_claim_once');
SELECT pg_get_triggerdef(oid) FROM pg_trigger
WHERE tgrelid = 'smart_storage_claims.attempts'::regclass AND NOT tgisinternal;
SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolinherit
FROM pg_roles WHERE rolname IN
('postgres', 'anon', 'authenticated', 'authenticator', 'service_role');
SELECT pg_get_userbyid(roleid) AS granted_role,
       pg_get_userbyid(member) AS member, admin_option
FROM pg_auth_members WHERE pg_get_userbyid(member) IN
('postgres', 'anon', 'authenticated', 'authenticator', 'service_role');
SELECT r.rolname, d.datname, setting FROM pg_db_role_setting s
LEFT JOIN pg_roles r ON r.oid = s.setrole
LEFT JOIN pg_database d ON d.oid = s.setdatabase
CROSS JOIN LATERAL unnest(s.setconfig) AS config(setting)
WHERE split_part(setting, '=', 1) IN
('pgrst.db_tx_end', 'pgrst.db_schemas', 'pgrst.db_pre_request', 'pgrst.db_extra_search_path');
-- These settings may be outside the database. Missing rows do NOT qualify them.
-- Provider record still required for effective PostgREST db-tx-end / hooks,
-- JWT role/GUC mapping/reset, exposed schemas and physical durability/restore.
ROLLBACK;
