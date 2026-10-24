-- Task 1.4A.1 metadata review only. Does not create/deploy/modify anything.
-- Run in the SAME confirmed development project's Dashboard SQL Editor.
-- Do not run storage-policies.draft.sql. Review results before bucket creation.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename IN ('objects', 'buckets')
ORDER BY tablename, policyname;

SELECT table_schema, table_name, grantee, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'storage' AND table_name IN ('objects', 'buckets')
ORDER BY table_name, grantee, privilege_type;

SELECT namespace.nspname AS schema_name, relation.relname AS table_name,
       relation.relrowsecurity AS rls_enabled,
       relation.relforcerowsecurity AS rls_forced
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'storage'
  AND relation.relname IN ('objects', 'buckets');

SELECT member_role.rolname AS member_role, granted_role.rolname AS granted_role,
       membership.admin_option
FROM pg_auth_members AS membership
JOIN pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname IN ('anon', 'authenticated', 'authenticator', 'service_role')
ORDER BY member_role.rolname, granted_role.rolname;

ROLLBACK;
-- This is a metadata inventory, not proof of effective authorization. Review
-- inherited roles, policy function definitions, broad OR policies and grants.
-- Inspect the global file size limit separately in Dashboard Storage Settings.
