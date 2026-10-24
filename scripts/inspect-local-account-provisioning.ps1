# Operator-run inspection only. No application configuration or credentials are read.
# Run from an interactive console; psql owns the password prompt.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw 'PostgreSQL 17 psql.exe is missing.' }
$proposal = Join-Path $PSScriptRoot '..\docs\local-account-provisioning.sql'
$source = [IO.File]::ReadAllText($proposal)
# Compare against reviewed proposal guards; never pass proposal SQL to PostgreSQL.
$expectedHashes = @('ef81771757b833c0a9688b977f63bcef', '3b216cdc26d1b295e0eafe3d60d8f9f4')
foreach ($hash in $expectedHashes) {
    if (-not $source.Contains("'$hash'")) { throw 'Proposal guards changed; review this inspection script before use.' }
}
$proposalHash = (Get-FileHash -LiteralPath $proposal -Algorithm SHA256).Hash
$directory = Join-Path ([IO.Path]::GetTempPath()) ('smart-storage-inspection-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $directory
$queryPath = Join-Path $directory 'inspection.sql'
$partialPath = Join-Path $directory 'inspection.partial.jsonl'
$reportPath = Join-Path $directory 'inspection.jsonl'
$sql = @'
\set ON_ERROR_STOP on
\set VERBOSITY terse
begin isolation level repeatable read read only;
set local statement_timeout='15s';
set local lock_timeout='2s';
set local search_path=pg_catalog;
select current_database()='smart_storage_gateway_test' and current_user='postgres'
 and inet_server_addr()='127.0.0.1'::inet and inet_server_port()=5432
 and current_setting('server_version_num')::integer between 170000 and 179999
 and current_setting('transaction_read_only')='on' as target_ok \gset
\if :target_ok
\else
\quit 3
\endif
select json_build_object('section','target','database',current_database(),'operator',current_user,
 'postgres_version',current_setting('server_version'),'read_only',current_setting('transaction_read_only'),
 'snapshot_time',transaction_timestamp(),'proposal_sha256', :'proposal_hash');
select json_build_object('section','proposal_guards','profile_fk_matches',exists(
 select from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_id_fkey'
 and contype='f' and confrelid='auth.users'::regclass
 and pg_get_constraintdef(oid)='FOREIGN KEY (id) REFERENCES auth.users(id)'),
 'volume_definition_matches',exists(select from pg_proc
 where oid=to_regprocedure('public.ss_volume_command(uuid,text,uuid,jsonb)')
 and proowner=(select oid from pg_roles where rolname='postgres') and prosecdef
 and proconfig=array['search_path=""']
 and md5(prosrc) in ('ef81771757b833c0a9688b977f63bcef','3b216cdc26d1b295e0eafe3d60d8f9f4')),
 'registry_collision',to_regclass('app_private.local_principals') is not null,
 'provision_function_collision',to_regprocedure('app_private.provision_local_account(text,uuid,bigint,integer)') is not null);
-- Report constraint structure, not literal CHECK expressions that may contain private values.
select json_build_object('section','constraints','table',conrelid::regclass::text,'name',conname,
 'type',contype,'columns',conkey,'referenced_table',nullif(confrelid,0)::regclass::text,
 'referenced_columns',confkey,'update_action',confupdtype,'delete_action',confdeltype,
 'validated',convalidated,'deferrable',condeferrable,'initially_deferred',condeferred,
 'definition_md5',md5(pg_get_constraintdef(oid)))
from pg_constraint where conrelid in ('auth.users'::regclass,'public.profiles'::regclass,'public.user_usage'::regclass)
 or confrelid in ('auth.users'::regclass,'public.profiles'::regclass,'public.user_usage'::regclass)
order by conrelid,conname;
select json_build_object('section','columns','table',attrelid::regclass::text,'number',attnum,
 'name',attname,'type',format_type(atttypid,atttypmod),'not_null',attnotnull,
 'default_md5',md5(pg_get_expr(d.adbin,d.adrelid)))
from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
where attrelid in ('auth.users'::regclass,'public.profiles'::regclass,'public.user_usage'::regclass)
 and attnum>0 and not attisdropped order by attrelid,attnum;
select json_build_object('section','triggers','table',t.tgrelid::regclass::text,'name',t.tgname,
 'internal',t.tgisinternal,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,
 'definition_md5',md5(pg_get_triggerdef(t.oid)),'function_source_md5',md5(p.prosrc),
 'function_owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef)
from pg_trigger t join pg_proc p on p.oid=t.tgfoid
where t.tgrelid in ('auth.users'::regclass,'public.profiles'::regclass,'public.user_usage'::regclass)
order by t.tgrelid,t.tgname;
select json_build_object('section','functions','function',p.oid::regprocedure::text,
 'owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'acl',proacl,
 'source_md5',md5(prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),
 'empty_search_path',coalesce(proconfig @> array['search_path=""'],false),
 'begin_patch_occurrences',(length(prosrc)-length(replace(prosrc,E'begin\n','')))/6)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.prokind='f' and n.nspname in ('public','app_private') order by p.oid;
select json_build_object('section','relation_acl','relation',c.oid::regclass::text,
 'owner',pg_get_userbyid(relowner),'acl',relacl,'rls',relrowsecurity,'force_rls',relforcerowsecurity)
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('auth','public','app_private') and c.relkind in ('r','p','v','S') order by c.oid;
select json_build_object('section','schema_acl','schema',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl)
from pg_namespace where nspname in ('auth','public','app_private');
select json_build_object('section','default_acl','owner',pg_get_userbyid(defaclrole),
 'schema',n.nspname,'object_type',defaclobjtype,'acl',defaclacl)
from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace;
-- pg_roles excludes password hashes. Role memberships expose inherited authority.
select json_build_object('section','roles','role',rolname,'superuser',rolsuper,
 'create_role',rolcreaterole,'login',rolcanlogin,'inherit',rolinherit,'bypass_rls',rolbypassrls)
from pg_roles order by rolname;
select json_build_object('section','memberships','role',pg_get_userbyid(roleid),
 'member',pg_get_userbyid(member),'admin',admin_option,'inherit',inherit_option,'set',set_option)
from pg_auth_members order by roleid,member;
select json_build_object('section','effective_runtime_authority','role',r.rolname,
 'function',p.oid::regprocedure::text,'execute',has_function_privilege(r.oid,p.oid,'EXECUTE'))
from pg_roles r cross join pg_proc p join pg_namespace n on n.oid=p.pronamespace
where r.rolname in ('anon','authenticated','service_role','ss_volume_gateway','ss_volume_runtime')
 and n.nspname in ('public','app_private') and p.prokind='f' order by r.rolname,p.oid;
select json_build_object('section','effective_runtime_tables','role',r.rolname,
 'table',c.oid::regclass::text,'select',has_table_privilege(r.oid,c.oid,'SELECT'),
 'insert',has_table_privilege(r.oid,c.oid,'INSERT'),'update',has_table_privilege(r.oid,c.oid,'UPDATE'),
 'delete',has_table_privilege(r.oid,c.oid,'DELETE'),'truncate',has_table_privilege(r.oid,c.oid,'TRUNCATE'))
from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
where r.rolname in ('anon','authenticated','service_role','ss_volume_gateway','ss_volume_runtime')
 and n.nspname in ('public','app_private') and c.relkind in ('r','p') order by r.rolname,c.oid;
select json_build_object('section','global_account_policy','rows',count(*),
 'all_zero',coalesce(bool_and(quota_bytes=0 and max_slots=0),false)) from app_private.account_policy;
select json_build_object('section','accounting','usage_rows',count(*),
 'reserved_bytes',coalesce(sum(reserved_bytes::numeric),0)::text,
 'stored_bytes',coalesce(sum(stored_bytes::numeric),0)::text,
 'quota_bytes',coalesce(sum(quota_bytes::numeric),0)::text,
 'active_slots',coalesce(sum(active_slots::numeric),0)::text,
 'max_slots',coalesce(sum(max_slots::numeric),0)::text,
 'historical_original_bytes',coalesce(sum(historical_original_bytes::numeric),0)::text,
 'historical_stored_bytes',coalesce(sum(historical_stored_bytes::numeric),0)::text,
 'accounts_with_reservations',count(*) filter(where reserved_bytes>0)) from public.user_usage;
select json_build_object('section','identity_integrity',
 'auth_count',(select count(*) from auth.users),'profile_count',(select count(*) from public.profiles),
 'profiles_missing_auth',(select count(*) from public.profiles p where not exists(select from auth.users a where a.id=p.id)),
 'usage_missing_profile',(select count(*) from public.user_usage u where not exists(select from public.profiles p where p.id=u.owner_id)),
 'profiles_missing_usage',(select count(*) from public.profiles p where not exists(select from public.user_usage u where u.owner_id=p.id)),
 'auth_without_profile',(select count(*) from auth.users a where not exists(select from public.profiles p where p.id=a.id)),
 'historical_ids_blocked_from_reprovisioning',(select count(*) from public.profiles),
 'duplicate_profile_ids',(select count(*) from (select id from public.profiles group by id having count(*)>1) x),
 'duplicate_usage_owners',(select count(*) from (select owner_id from public.user_usage group by owner_id having count(*)>1) x));
select json_build_object('section','limitations','verdict','MANUAL_REVIEW_REQUIRED',
 'notes','No candidate subject supplied: candidate collision is unverified. Existing registry collision blocks deployment pending separate review. Hashes do not establish trigger semantics. No backup, restore, lock rehearsal or provisioning performed. Review ACLs and memberships; this is not an automatic deployment approval.');
rollback;
'@
$savedEnvironment = @{}
try {
    # Do not use inherited libpq services, password sources, options or startup files.
    foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'PG*' })) {
        $savedEnvironment[$entry.Name] = $entry.Value
        [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
    }
    $env:PGPASSFILE = Join-Path $directory 'absent-password-file'
    $env:PGCONNECT_TIMEOUT = '5'
    $env:PGOPTIONS = '-c default_transaction_read_only=on'
    [IO.File]::WriteAllText($queryPath, $sql, [Text.UTF8Encoding]::new($false))
    Write-Host 'Local read-only inspection. Enter the operator password only at the psql prompt.'
    # Suppress server diagnostics: unexpected errors may contain private literals.
    & $psql -X -W -h 127.0.0.1 -p 5432 -U postgres -d smart_storage_gateway_test `
        -q -A -t -P pager=off -v ON_ERROR_STOP=1 -v "proposal_hash=$proposalHash" `
        -f $queryPath -o $partialPath 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Inspection failed or target guard rejected the connection. Partial report is incomplete; do not use for deployment approval.' }
    Move-Item -LiteralPath $partialPath -Destination $reportPath
    Write-Host "Inspection complete: $reportPath"
    Write-Host 'Manual review required. No deployment or provisioning is authorized by this report.'
}
finally {
    foreach ($name in @('PGPASSFILE','PGCONNECT_TIMEOUT','PGOPTIONS')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $queryPath) { Remove-Item -LiteralPath $queryPath }
}
