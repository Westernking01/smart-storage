-- Run this ONE SELECT in Dashboard project rrylhvqalsxjnkdkpwde as postgres.
-- Export the entire grid: exactly 14 numbered rows, with JSON details.
-- SELECT/catalog reads only: no claim RPC, SET, DDL, Auth or Storage requests.
-- Declared target literals are NOT independent proof of project attribution.
WITH
claim_table AS (
  SELECT c.*, n.nspname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'smart_storage_claims' AND c.relname = 'attempts'
),
claim_functions AS (
  SELECT p.*, n.nspname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'smart_storage_claims'
     OR (n.nspname = 'public' AND p.proname = 'smart_storage_claim_once')
),
selected_roles AS (
  SELECT * FROM pg_roles WHERE rolname IN
    ('postgres', 'anon', 'authenticated', 'authenticator', 'service_role')
),
sections AS (
  SELECT 1 AS sequence, 'context'::text AS section,
    jsonb_build_object(
      'observed_at', statement_timestamp(),
      'declared_expected_project', 'rrylhvqalsxjnkdkpwde',
      'database', current_database(), 'session_user', session_user,
      'current_user', current_user,
      'server_version', current_setting('server_version'),
      'fsync', current_setting('fsync'),
      'full_page_writes', current_setting('full_page_writes'),
      'session_synchronous_commit', current_setting('synchronous_commit'),
      'can_select_claims', has_table_privilege(current_user,
        'smart_storage_claims.attempts', 'SELECT'),
      'claims_rls_filter_active', row_security_active('smart_storage_claims.attempts'::regclass)
    ) AS details
  UNION ALL
  SELECT 2, 'private_schema', coalesce(jsonb_agg(jsonb_build_object(
    'name', n.nspname, 'owner', pg_get_userbyid(n.nspowner),
    'acl', n.nspacl
  ) ORDER BY n.nspname), '[]'::jsonb)
  FROM pg_namespace n WHERE n.nspname = 'smart_storage_claims'
  UNION ALL
  SELECT 3, 'relations', coalesce(jsonb_agg(jsonb_build_object(
    'name', c.relname, 'kind', c.relkind, 'persistence', c.relpersistence,
    'rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity,
    'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl
  ) ORDER BY c.relname), '[]'::jsonb)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'smart_storage_claims'
  UNION ALL
  SELECT 4, 'columns', coalesce(jsonb_agg(jsonb_build_object(
    'position', a.attnum, 'name', a.attname,
    'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
    'default', pg_get_expr(d.adbin, d.adrelid)
  ) ORDER BY a.attnum), '[]'::jsonb)
  FROM pg_attribute a JOIN claim_table t ON t.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 5, 'constraints', coalesce(jsonb_agg(jsonb_build_object(
    'name', c.conname, 'type', c.contype, 'validated', c.convalidated,
    'definition', pg_get_constraintdef(c.oid, true)
  ) ORDER BY c.conname), '[]'::jsonb)
  FROM pg_constraint c JOIN claim_table t ON t.oid = c.conrelid
  UNION ALL
  SELECT 6, 'claim_state', jsonb_build_object(
    'visible_count', count(*),
    'rows', coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.operation), '[]'::jsonb)
  ) FROM smart_storage_claims.attempts a
  UNION ALL
  SELECT 7, 'functions', coalesce(jsonb_agg(jsonb_build_object(
    'signature', p.oid::regprocedure::text, 'schema', p.nspname,
    'owner', pg_get_userbyid(p.proowner), 'security_definer', p.prosecdef,
    'volatility', p.provolatile, 'config', p.proconfig, 'acl', p.proacl,
    'definition', pg_get_functiondef(p.oid)
  ) ORDER BY p.nspname, p.proname, p.oid), '[]'::jsonb)
  FROM claim_functions p
  UNION ALL
  SELECT 8, 'triggers', coalesce(jsonb_agg(jsonb_build_object(
    'name', g.tgname, 'enabled', g.tgenabled,
    'function', g.tgfoid::regprocedure::text,
    'definition', pg_get_triggerdef(g.oid, true)
  ) ORDER BY g.tgname), '[]'::jsonb)
  FROM pg_trigger g JOIN claim_table t ON t.oid = g.tgrelid
  WHERE NOT g.tgisinternal
  UNION ALL
  SELECT 9, 'rls_policies', coalesce(jsonb_agg(jsonb_build_object(
    'name', p.polname, 'command', p.polcmd, 'permissive', p.polpermissive,
    'roles', p.polroles, 'using', pg_get_expr(p.polqual, p.polrelid),
    'with_check', pg_get_expr(p.polwithcheck, p.polrelid)
  ) ORDER BY p.polname), '[]'::jsonb)
  FROM pg_policy p JOIN claim_table t ON t.oid = p.polrelid
  UNION ALL
  SELECT 10, 'roles', coalesce(jsonb_agg(jsonb_build_object(
    'name', r.rolname, 'login', r.rolcanlogin, 'superuser', r.rolsuper,
    'create_role', r.rolcreaterole, 'create_db', r.rolcreatedb,
    'replication', r.rolreplication, 'bypass_rls', r.rolbypassrls,
    'inherit', r.rolinherit
  ) ORDER BY r.rolname), '[]'::jsonb)
  FROM selected_roles r
  UNION ALL
  SELECT 11, 'role_memberships', coalesce(jsonb_agg(jsonb_build_object(
    'granted_role', pg_get_userbyid(m.roleid),
    'member', pg_get_userbyid(m.member), 'grantor', pg_get_userbyid(m.grantor),
    'admin_option', m.admin_option,
    'inherit_option', to_jsonb(m)->'inherit_option',
    'set_option', to_jsonb(m)->'set_option'
  ) ORDER BY m.member, m.roleid, m.grantor), '[]'::jsonb)
  FROM pg_auth_members m JOIN selected_roles r ON r.oid = m.member
  UNION ALL
  SELECT 12, 'effective_privileges', coalesce(jsonb_agg(jsonb_build_object(
    'role', r.rolname,
    'private_schema_usage', has_schema_privilege(r.oid, 'smart_storage_claims', 'USAGE'),
    'private_schema_create', has_schema_privilege(r.oid, 'smart_storage_claims', 'CREATE'),
    'table_select', has_table_privilege(r.oid, 'smart_storage_claims.attempts', 'SELECT'),
    'table_insert', has_table_privilege(r.oid, 'smart_storage_claims.attempts', 'INSERT'),
    'table_update', has_table_privilege(r.oid, 'smart_storage_claims.attempts', 'UPDATE'),
    'table_delete', has_table_privilege(r.oid, 'smart_storage_claims.attempts', 'DELETE'),
    'table_truncate', has_table_privilege(r.oid, 'smart_storage_claims.attempts', 'TRUNCATE'),
    'table_references', has_table_privilege(r.oid, 'smart_storage_claims.attempts', 'REFERENCES'),
    'table_trigger', has_table_privilege(r.oid, 'smart_storage_claims.attempts', 'TRIGGER'),
    'claim_rpc_execute', has_function_privilege(r.oid, 'public.smart_storage_claim_once(text)', 'EXECUTE'),
    'mutation_function_execute', has_function_privilege(r.oid, 'smart_storage_claims.deny_mutation()', 'EXECUTE')
  ) ORDER BY r.rolname), '[]'::jsonb)
  FROM selected_roles r
  UNION ALL
  SELECT 13, 'allowlisted_postgrest_db_role_settings', coalesce(jsonb_agg(jsonb_build_object(
    'role', r.rolname, 'database', d.datname, 'setting', config.setting
  ) ORDER BY s.setrole, s.setdatabase, config.setting), '[]'::jsonb)
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole
  LEFT JOIN pg_database d ON d.oid = s.setdatabase
  CROSS JOIN LATERAL unnest(s.setconfig) AS config(setting)
  WHERE split_part(config.setting, '=', 1) IN
    ('pgrst.db_tx_end', 'pgrst.db_schemas', 'pgrst.db_pre_request', 'pgrst.db_extra_search_path')
  UNION ALL
  SELECT 14, 'evidence_limits', jsonb_build_object(
    'empty_settings_mean', 'not observed in database catalog; not proof of deployed defaults',
    'project_identity', 'operator must attribute this export to the confirmed Dashboard project',
    'not_established', jsonb_build_array(
      'effective gateway JWT role/GUC mapping and reset',
      'effective RPC exposure, hooks and commit-before-response',
      'provider physical crash/failover durability',
      'permanent retention and privileged deletion/backup restore/rollback fence',
      'historical changes or unchanged predeployment privileges',
      'Storage object absence, upload or download success'
    )
  )
)
SELECT sequence, section, details FROM sections ORDER BY sequence;
