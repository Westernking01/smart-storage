# Operator-run catalog inspection only. Never run deployment SQL or application functions.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw 'PostgreSQL 17 psql.exe is missing.' }
$baselinePath = Join-Path $PSScriptRoot 'legacy-authority-baseline.json'
$baseline = [IO.File]::ReadAllText($baselinePath) | ConvertFrom-Json
if (@($baseline | Where-Object kind -eq 'helper').Count -ne 105 -or @($baseline | Where-Object kind -eq 'legacy').Count -ne 7) { throw 'Baseline inventory invalid.' }
$values = foreach ($row in $baseline) {
    if ($row.signature -notmatch '^public\.[a-z0-9_]+\([a-z0-9, ]*\)$' -or $row.hash -notmatch '^[a-f0-9]{32}$' -or $row.kind -notin @('helper','legacy')) { throw 'Baseline entry invalid.' }
    "('$($row.signature)','$($row.hash)','$($row.kind)')"
}
$directory = Join-Path ([IO.Path]::GetTempPath()) ('smart-storage-legacy-inspection-' + [guid]::NewGuid().ToString('N'))
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
 and session_user='postgres' and inet_server_addr()='127.0.0.1'::inet and inet_server_port()=5432
 and current_setting('server_version_num')::integer between 170000 and 179999
 and current_setting('transaction_read_only')='on' as target_ok \gset
\if :target_ok
\else
\quit 3
\endif
select json_build_object('section','target','database',current_database(),'operator',current_user,
 'version',current_setting('server_version'),'read_only',current_setting('transaction_read_only'),
 'snapshot_time',transaction_timestamp());
WITH baseline(signature,expected,kind) AS (VALUES __BASELINE__),
selected AS (select b.*,p.*,n.nspname from baseline b left join pg_proc p on p.oid=to_regprocedure(b.signature)
 left join pg_namespace n on n.oid=p.pronamespace)
select json_build_object('section','definitions','function',signature,'kind',kind,'present',oid is not null,
 'hash_basis',case when kind='helper' then 'recorded full definition' else 'migration-derived source; not prior installed evidence' end,
 'expected_md5',expected,'actual_md5',case when kind='helper' then md5(pg_get_functiondef(oid)) else md5(prosrc) end,
 'matches',case when kind='helper' then md5(pg_get_functiondef(oid)) else md5(prosrc) end=expected,
 'owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'ordinary_function',prokind='f',
 'empty_search_path',coalesce(proconfig @> array['search_path=""'],false),
 'default_acl',proacl is null,
 'gateway_guard_text_present',position('GATEWAY_V1_REQUIRED' in prosrc)>0,
 'gateway_sessions_reference',position('app_private.gateway_sessions' in prosrc)>0)
from selected order by signature;
select json_build_object('section','unexpected_helpers','function',p.oid::regprocedure::text)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'race%' and p.prokind='f'
 and p.oid not in (select to_regprocedure(v.signature) from (values __BASELINE__) v(signature,expected,kind) where to_regprocedure(v.signature) is not null);
WITH selected AS (select p.* from pg_proc p where p.oid in
 (select to_regprocedure(v.signature) from (values __BASELINE__) v(signature,expected,kind)))
select json_build_object('section','function_grants','function',p.oid::regprocedure::text,
 'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
 'grantor',pg_get_userbyid(a.grantor),'grant_option',a.is_grantable)
from selected p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
where a.privilege_type='EXECUTE' order by p.oid,a.grantee;
WITH selected AS (select p.* from pg_proc p where p.oid in
 (select to_regprocedure(v.signature) from (values __BASELINE__) v(signature,expected,kind)))
select json_build_object('section','effective_execute','role',r.rolname,'function',p.oid::regprocedure::text,
 'execute',has_function_privilege(r.oid,p.oid,'EXECUTE'),'schema_usage',has_schema_privilege(r.oid,p.pronamespace,'USAGE'),
 'superuser',r.rolsuper,'login',r.rolcanlogin)
from selected p cross join pg_roles r order by r.rolname,p.oid;
select json_build_object('section','membership_edges','role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),
 'admin',admin_option,'inherit',inherit_option,'set',set_option) from pg_auth_members order by roleid,member;
select json_build_object('section','membership_closure','member',m.rolname,'role',r.rolname,
 'member_reachable',pg_has_role(m.oid,r.oid,'MEMBER'),'inherited_now',pg_has_role(m.oid,r.oid,'USAGE'),
 'set_role_reachable',pg_has_role(m.oid,r.oid,'SET'))
from pg_roles m cross join pg_roles r where m.oid<>r.oid and pg_has_role(m.oid,r.oid,'MEMBER') order by m.rolname,r.rolname;
-- Catalog links only; no pg_describe_object calls that could expose literal expressions.
WITH selected AS (select to_regprocedure(v.signature)::oid oid from (values __BASELINE__) v(signature,expected,kind))
select json_build_object('section','dependencies','class',d.classid::regclass::text,'object_oid',d.objid,
 'subobject',d.objsubid,'referenced_class',d.refclassid::regclass::text,'referenced_oid',d.refobjid,
 'referenced_subobject',d.refobjsubid,'type',d.deptype,
 'function',p.oid::regprocedure::text,'referenced_function',rp.oid::regprocedure::text,
 'relation',c.oid::regclass::text,'referenced_relation',rc.oid::regclass::text)
from pg_depend d left join pg_proc p on d.classid='pg_proc'::regclass and p.oid=d.objid
 left join pg_proc rp on d.refclassid='pg_proc'::regclass and rp.oid=d.refobjid
 left join pg_class c on d.classid='pg_class'::regclass and c.oid=d.objid
 left join pg_class rc on d.refclassid='pg_class'::regclass and rc.oid=d.refobjid
where (d.classid='pg_proc'::regclass and d.objid in(select oid from selected))
 or (d.refclassid='pg_proc'::regclass and d.refobjid in(select oid from selected))
order by d.classid,d.objid,d.refclassid,d.refobjid;
-- Include all retained race relations so the three historical SELECT grants can be reviewed without assuming their names.
WITH expected(name) AS (values ('public.race43_job'),('public.race44_job'),('public.race44_certs'))
select json_build_object('section','expected_fixture_select','table',e.name,'present',c.oid is not null,
 'cleaner_explicit_select',exists(select from aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
 where r.rolname='ss_gateway_cleaner' and a.privilege_type='SELECT'))
from expected e left join pg_class c on c.oid=to_regclass(e.name);
select json_build_object('section','fixture_select_summary','expected_nonowner_select_grants',3,
 'actual_nonowner_select_grants',count(*),'matches_expected_count',count(*)=3,
 'note','Count alone does not establish that the same three grants were retained; review exact table/grantee rows.')
from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
where n.nspname='public' and c.relname like 'race%' and c.relkind in('r','p')
 and a.privilege_type='SELECT' and a.grantee<>c.relowner;
select json_build_object('section','fixture_column_grants','table',c.oid::regclass::text,
 'column',att.attname,'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
 'privilege',a.privilege_type,'grant_option',a.is_grantable)
from pg_class c join pg_namespace n on n.oid=c.relnamespace
 join pg_attribute att on att.attrelid=c.oid and att.attnum>0 and not att.attisdropped
 cross join lateral aclexplode(att.attacl) a
where n.nspname='public' and c.relname like 'race%' and c.relkind in('r','p');
select json_build_object('section','fixture_acl','table',c.oid::regclass::text,'owner',pg_get_userbyid(c.relowner),
 'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
 'privilege',a.privilege_type,'grant_option',a.is_grantable)
from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
where n.nspname='public' and c.relname like 'race%' and c.relkind in('r','p') order by c.oid,a.grantee,a.privilege_type;
select json_build_object('section','fixture_effective_select','table',c.oid::regclass::text,'role',r.rolname,
 'select',has_table_privilege(r.oid,c.oid,'SELECT'),'any_column_select',has_any_column_privilege(r.oid,c.oid,'SELECT'),
 'schema_usage',has_schema_privilege(r.oid,c.relnamespace,'USAGE'))
from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r
where n.nspname='public' and c.relname like 'race%' and c.relkind in('r','p') order by c.oid,r.rolname;
select json_build_object('section','guard_triggers','table',t.tgrelid::regclass::text,'trigger',t.tgname,
 'enabled',t.tgenabled,'function',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
 'security_definer',p.prosecdef,'empty_search_path',coalesce(p.proconfig @> array['search_path=""'],false),
 'source_matches_reviewed_guard',md5(p.prosrc)=case p.proname when 'gateway_identity_guard' then '8efea3e52947b78e115568a6f6dab547' when 'gateway_legacy_request_guard' then 'e43e75b4547d79a2899418c8ebbff2af' end,
 'source_md5',md5(p.prosrc),'definition_md5',md5(pg_get_functiondef(p.oid)),
 'gateway_guard_text_present',position('GATEWAY_V1_REQUIRED' in p.prosrc)>0,
 'evidence_guard_text_present',position('EVIDENCE_REQUIRED' in p.prosrc)>0)
from pg_trigger t join pg_proc p on p.oid=t.tgfoid
where p.oid in(to_regprocedure('app_private.gateway_identity_guard()'),to_regprocedure('app_private.gateway_legacy_request_guard()'))
order by t.tgrelid,t.tgname;
select json_build_object('section','limitations','verdict','MANUAL_REVIEW_REQUIRED',
 'notes','No function executed and no table contents read. Text guards and hashes do not prove control flow or runtime exploitability. MD5 is drift evidence, not authentication. Legacy hashes are source-derived, not a recorded installed baseline. pg_depend omits many PL/pgSQL/string SQL and dynamic SQL references; absent dependencies do not imply no callers. Effective EXECUTE includes PUBLIC/inherited authority; SET-role closure is reported separately. SELECT grants do not establish RLS-visible rows. HBA, login reachability, JWT/API exposure, actual guard denial and fixture contents are untested. No activation or permission change authorized.');
rollback;
'@
$sql = $sql.Replace('__BASELINE__', ($values -join ','))
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
        -q -A -t -P pager=off -v ON_ERROR_STOP=1  `
        -f $queryPath -o $partialPath 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Inspection failed or target guard rejected the connection. Partial report is incomplete; do not use for deployment approval.' }
    Move-Item -LiteralPath $partialPath -Destination $reportPath
    Write-Host "Inspection complete: $reportPath"
    Write-Host 'Manual review required. Catalog evidence only; runtime exploitability is not established.'
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
