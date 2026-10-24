-- REVIEW ONLY. DO NOT EXECUTE without separate cluster-role approval.
-- Local PostgreSQL 17 / 127.0.0.1:5432/smart_storage_gateway_test only.
-- No password is generated, read or assigned. Abort on an existing role collision.
begin;
do $$ begin
 if exists(select from pg_catalog.pg_roles where rolname='ss_gateway_runtime_test')
 then raise exception 'ROLE_COLLISION'; end if;
 if current_database()<>'smart_storage_gateway_test' then raise exception 'WRONG_DATABASE'; end if;
end $$;
create role ss_gateway_runtime_test login nosuperuser nocreatedb nocreaterole
 noreplication nobypassrls noinherit;
grant connect on database smart_storage_gateway_test to ss_gateway_runtime_test;
grant ss_gateway_executor to ss_gateway_runtime_test with admin false, inherit false, set true;
alter role ss_gateway_runtime_test in database smart_storage_gateway_test set search_path='';
commit;
-- Runtime protocol: BEGIN; SET LOCAL ROLE ss_gateway_executor; RPC; COMMIT.
-- End every transaction before provider I/O. Never SET ROLE on a pooled session.
-- No table ownership, table privileges, private schema usage or direct RPC grants.
-- Executor remains NOLOGIN. Membership grants executor's existing RPC surface;
-- UUID owner/executor inputs are trusted backend assertions, not end-user Auth.

-- REQUIRED separate connection-policy approval before provisioning/use:
-- PUBLIC CONNECT currently covers postgres/template1 and this database.
-- REVOKE CONNECT FROM ss_gateway_runtime_test cannot override PUBLIC.
-- Place these pg_hba.conf records BEFORE any general allow record, preserving
-- administrator access; review/reload separately. Do not apply in this task.
-- host smart_storage_gateway_test ss_gateway_runtime_test 127.0.0.1/32 scram-sha-256
-- host all ss_gateway_runtime_test 0.0.0.0/0 reject
-- host all ss_gateway_runtime_test ::0/0 reject
-- local all ss_gateway_runtime_test reject
-- Authentication provisioning is separate; this SQL intentionally establishes
-- no usable password. No application may fall back to postgres credentials.

-- Post-approval checks (read only; run as administrator):
select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
 rolbypassrls,rolinherit from pg_catalog.pg_roles
 where rolname in ('ss_gateway_runtime_test','ss_gateway_executor');
select pg_catalog.pg_get_userbyid(roleid),pg_catalog.pg_get_userbyid(member),
 admin_option,inherit_option,set_option from pg_catalog.pg_auth_members
 where member=(select oid from pg_catalog.pg_roles where rolname='ss_gateway_runtime_test');
select n.nspname,c.relname from pg_catalog.pg_class c
 join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','app_private') and c.relowner=
 (select oid from pg_catalog.pg_roles where rolname='ss_gateway_runtime_test');
select n.nspname,c.relname,
 pg_catalog.has_table_privilege('ss_gateway_runtime_test',c.oid,'SELECT,INSERT,UPDATE,DELETE') as login_access,
 pg_catalog.has_table_privilege('ss_gateway_executor',c.oid,'SELECT,INSERT,UPDATE,DELETE') as executor_access
 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname='app_private' and c.relkind='r';
select d.datname,pg_catalog.has_database_privilege('ss_gateway_runtime_test',d.oid,'CONNECT')
 from pg_catalog.pg_database d;
-- ACL CONNECT may still be true due to PUBLIC; actual denial must be verified
-- through independent login attempts after reviewed HBA/auth setup, not claimed
-- from SET LOCAL ROLE tests. Test wrong databases, IPv6 and socket paths too.
select p.oid::regprocedure,
 pg_catalog.has_function_privilege('ss_gateway_runtime_test',p.oid,'EXECUTE') as login_execute,
 pg_catalog.has_function_privilege('ss_gateway_executor',p.oid,'EXECUTE') as switched_execute
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'ss_gateway_%';
