// Catalog-only comparison; psql consumes established external admin passfile.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const env={...process.env};
for(const k of Object.keys(env)) if(k.startsWith('PG')) delete env[k];
env.PGPASSFILE='C:/ProgramData/SmartStoragePgTest/pgpass.conf';
env.PGCONNECT_TIMEOUT='3';
const r=spawnSync('C:/Program Files/PostgreSQL/17/bin/psql.exe',
 ['-X','-w','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','5432','-U','postgres','-d','smart_storage_gateway_test'],
 {env,encoding:'utf8',timeout:15000,input:`BEGIN READ ONLY;
 DO $$ BEGIN ASSERT current_database()='smart_storage_gateway_test' AND current_user='postgres' AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432; END $$;
 SELECT coalesce(json_agg(json_build_object('name',p.proname,'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'config',p.proconfig,
 'observer',has_function_privilege('ss_gateway_observer',p.oid,'EXECUTE'),'login',has_function_privilege('ss_gateway_observer_runtime_test',p.oid,'EXECUTE'))),'[]')
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'ss_%'; ROLLBACK;`});
if(r.status!==0) { process.stderr.write(r.stderr??'LOCAL_CATALOG_UNAVAILABLE'); process.exit(1); }
const rows=JSON.parse(r.stdout.trim());
const expected=new Map();
for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) {
 const source=readFileSync('supabase/migrations/'+f,'utf8');
 const pattern=/create\s+(?:or\s+replace\s+)?function\s+public\.(ss_\w+)\s*\([\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\2/gi;
 for(const m of source.matchAll(pattern)) expected.set(m[1],{body:m[3],source:f});
}
const normalize=s=>s.replaceAll('\r\n','\n').trim();
// Lifecycle migration intentionally patches earlier functions with literal replace.
// Reconstruct those reviewed changes rather than comparing obsolete CREATE bodies.
const lifecycle=readFileSync('supabase/migrations/202610160007_gateway_lifecycle.sql','utf8');
const literal="(?:'(?:[^']|'')*'|\\$\\w*\\$[\\s\\S]*?\\$\\w*\\$)";
const patches=new RegExp("d\\s*:=\\s*pg_get_functiondef\\('public\\.(ss_\\w+)[^;]*;|d\\s*:=\\s*replace\\(d,\\s*("+literal+"),\\s*("+literal+")\\s*\\)", 'g');
const decode=s=>s.startsWith("'")?s.slice(1,-1).replaceAll("''", "'"):s.slice(s.indexOf('$',1)+1,s.lastIndexOf('$',s.length-2));
let target;
for(const m of lifecycle.matchAll(patches)) {
 if(m[1]) target=m[1];
 else if(expected.has(target)) { const e=expected.get(target); e.body=e.body.replaceAll(decode(m[2]),decode(m[3])); }
}
const allowed=new Set(['ss_gateway_discover_resource_v1','ss_gateway_reconcile_discoveries_v1','ss_gateway_record_receipt_v1','ss_seeded_fixture_resolve_v1','ss_seeded_fixture_receipt_v1']);
const checks=rows.map(p=>({name:p.name,check:'observer_function_authority',pass:p.observer===allowed.has(p.name)&&!p.login}));
for(const [name,e] of expected) if(name.startsWith('ss_gateway_')) {
 const matches=rows.filter(p=>p.name===name);
 checks.push({name,check:'gateway_body_owner_definer',pass:matches.length===1&&normalize(matches[0].body)===normalize(e.body)&&matches[0].owner==='postgres'&&matches[0].definer&&matches[0].config?.includes('search_path=""'),source:e.source});
}
const report={at:new Date().toISOString(),status:checks.every(c=>c.pass)?'PASS':'FAIL',checks,providerRequests:0,registrationPerformed:false};
writeFileSync('tests/database/seeded-fixture-gateway-integrity.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=report.status==='PASS'?0:1;
