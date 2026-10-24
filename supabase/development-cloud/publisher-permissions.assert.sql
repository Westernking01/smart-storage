-- Read-only assertion shared by provisioning and restricted-login preflight.
-- PostgreSQL 16+; PUBLIC privileges are additive and cannot be denied per role.
DO $check$
DECLARE r text; n record; p record; c record;
 allowed text[] := ARRAY['public.ss_begin_attempt_request(uuid,bigint,uuid,bigint)','public.ss_finish_attempt_request(uuid,bigint)','public.ss_record_observation(uuid,bigint,bigint)','public.ss_finalize_verified(uuid,jsonb,bigint,text,text)'];
BEGIN
 IF current_database()<>'postgres' OR current_setting('server_version_num')::int<160000 THEN RAISE EXCEPTION 'Publisher database/version mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ss_dev_cloud_publisher_login' AND rolcanlogin AND NOT (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AND rolconnlimit=2) THEN RAISE EXCEPTION 'Publisher login attributes drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ss_dev_cloud_publisher' AND NOT (rolcanlogin OR rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN RAISE EXCEPTION 'Publisher role attributes drift'; END IF;
 -- PostgreSQL 16+: a non-superuser CREATEROLE creator receives an automatic
 -- ADMIN-only grant of the new role from bootstrap grantor OID 10. This is
 -- postgres administering the login, never the login gaining postgres authority.
 -- Accept only that exact incoming edge; all outgoing membership stays SET-only.
 IF (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member='ss_dev_cloud_publisher_login'::pg_catalog.regrole)<>1 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member='ss_dev_cloud_publisher_login'::pg_catalog.regrole AND roleid='ss_dev_cloud_publisher'::pg_catalog.regrole AND NOT admin_option AND NOT inherit_option AND set_option) OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member='ss_dev_cloud_publisher'::pg_catalog.regrole OR (roleid='ss_dev_cloud_publisher_login'::pg_catalog.regrole AND NOT (member='postgres'::pg_catalog.regrole AND grantor=10 AND admin_option AND NOT inherit_option AND NOT set_option AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='postgres' AND rolcreaterole AND NOT rolsuper)))) THEN RAISE EXCEPTION 'Publisher membership closure drift'; END IF;
 FOREACH r IN ARRAY ARRAY['ss_dev_cloud_publisher_login','ss_dev_cloud_publisher'] LOOP
  IF has_database_privilege(r,current_database(),'CREATE') THEN RAISE EXCEPTION 'Publisher database CREATE exposure: %',r; END IF;
  -- PUBLIC TEMP is additive. Reject redundant direct grants and grant options.
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(d.datacl,pg_catalog.acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.privilege_type='TEMPORARY' AND (a.grantee=r::pg_catalog.regrole OR (a.grantee=0 AND a.is_grantable))) OR
     (has_database_privilege(r,current_database(),'TEMP') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(d.datacl,pg_catalog.acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='TEMPORARY' AND NOT a.is_grantable)) THEN RAISE EXCEPTION 'Publisher non-PUBLIC TEMP exposure: %',r; END IF;
  FOR n IN SELECT oid,nspname,nspowner FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_(toast|temp)' LOOP
   IF n.nspowner= r::pg_catalog.regrole OR has_schema_privilege(r,n.oid,'CREATE') THEN RAISE EXCEPTION 'Publisher schema ownership/CREATE exposure: %',n.nspname; END IF;
   FOR p IN SELECT oid,proowner,oid::pg_catalog.regprocedure::text AS signature FROM pg_catalog.pg_proc WHERE pronamespace=n.oid LOOP
    IF p.proowner=r::pg_catalog.regrole THEN RAISE EXCEPTION 'Publisher routine ownership exposure'; END IF;
    IF has_schema_privilege(r,n.oid,'USAGE') AND has_function_privilege(r,p.oid,'EXECUTE') AND NOT (r='ss_dev_cloud_publisher' AND p.oid=ANY(ARRAY(SELECT to_regprocedure(a)::oid FROM unnest(allowed) a))) THEN RAISE EXCEPTION 'Publisher unrelated routine exposure: % / %',r,p.signature; END IF;
   END LOOP;
   FOR c IN SELECT oid,relname,relowner,relkind,relacl FROM pg_catalog.pg_class WHERE relnamespace=n.oid AND relkind IN ('r','p','v','m','f','S') LOOP
    IF c.relowner=r::pg_catalog.regrole OR (c.relkind='S' AND has_sequence_privilege(r,c.oid,'USAGE,SELECT,UPDATE')) OR (c.relkind<>'S' AND (has_table_privilege(r,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r,c.oid,'INSERT,UPDATE,REFERENCES') OR
      ((has_table_privilege(r,c.oid,'SELECT') OR has_any_column_privilege(r,c.oid,'SELECT')) AND NOT (
       -- Exact inaccessible monitoring views only. PUBLIC SELECT is additive;
       -- never excuse explicit role/column grants, grant options or schema access.
       n.nspname='extensions' AND c.relkind='v' AND c.relname IN ('pg_stat_statements','pg_stat_statements_info')
       AND NOT has_schema_privilege(r,n.oid,'USAGE')
       AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee=0 AND a.privilege_type='SELECT' AND NOT a.is_grantable)
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee=r::pg_catalog.regrole OR (a.grantee=0 AND (a.is_grantable OR a.privilege_type<>'SELECT')))
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND (a.grantee=0 OR a.grantee=r::pg_catalog.regrole))
      )))) THEN RAISE EXCEPTION 'Publisher relation privilege exposure: %',c.oid::pg_catalog.regclass; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 IF NOT has_database_privilege('ss_dev_cloud_publisher_login',current_database(),'CONNECT') THEN RAISE EXCEPTION 'Publisher CONNECT missing'; END IF;
 FOREACH r IN ARRAY allowed LOOP
  IF to_regprocedure(r) IS NULL OR NOT has_function_privilege('ss_dev_cloud_publisher',r,'EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(r) AND prosecdef AND proowner='postgres'::pg_catalog.regrole AND proconfig=ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Publisher RPC contract drift: %',r; END IF;
 END LOOP;
 IF NOT has_schema_privilege('ss_dev_cloud_publisher','public','USAGE') THEN RAISE EXCEPTION 'Publisher public USAGE missing'; END IF;
 -- Pin every non-catalog helper and trigger reached by publisher writes.
 FOR p IN SELECT * FROM (VALUES
   ('app_private.dev_cloud_owner()','831b39d996265a99b68ed8c1a6f4e67b',true,true),
   ('auth.uid()','cdef18c69c4f4cbbced2eaf81e628b49',false,false),
   ('auth.jwt()','2db09c3fc855ba90e71d3ae28cfadae3',false,false),
   ('app_private.file_json(public.files)','7858e8836b576cc99e9a40f3b20ba4b9',false,true),
   ('app_private.owner_immutable()','d17925c38876dd82f28b026783115476',false,true),
   ('app_private.file_transition()','ffaff8df10406a895ef43bd38fec45fe',false,true),
   ('app_private.attempt_counters()','af2ae32bae16bfc5a8b260e2435a66eb',false,true)
 ) AS helpers(signature,body_hash,definer,fixed_path) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=split_part(p.signature,'.',1)) AND proname=split_part(split_part(p.signature,'.',2),'(',1) AND ((p.signature='app_private.file_json(public.files)' AND pronargs=1 AND proargtypes[0]='public.files'::pg_catalog.regtype) OR (p.signature<>'app_private.file_json(public.files)' AND pronargs=0)) AND ((p.fixed_path AND proowner='postgres'::pg_catalog.regrole) OR (NOT p.fixed_path AND proowner IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('postgres','supabase_auth_admin')))) AND prosecdef=p.definer AND md5(replace(prosrc,E'\r\n',E'\n'))=p.body_hash AND ((NOT p.fixed_path AND proconfig IS NULL) OR (p.fixed_path AND proconfig=ARRAY['search_path=""']))) THEN RAISE EXCEPTION 'Publisher helper contract drift: %',p.signature; END IF;
 END LOOP;
END $check$;

