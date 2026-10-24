import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base=path.resolve(import.meta.dirname,'../.cache/browser-roundtrip-20261020');
const report={accountAllocation:'not attempted',runtimeActive:false,transfersEnabled:false,adr041:'OPEN'};
const options={host:'127.0.0.1',port:55461,database:'smart_storage_gateway_test'};
const admin=new pg.Client({...options,user:'postgres',password:process.env.DISPOSABLE_ADMIN_PASSWORD});
let runtime;
try {
 await admin.connect();
 const {rows:[t]}=await admin.query("select current_setting('data_directory') dir,current_setting('port') port,current_setting('listen_addresses') listen,current_database() db,current_user usr");
 assert.equal(path.resolve(t.dir).toLowerCase(),path.join(base,'postgres').toLowerCase());
 assert.equal(t.port,'55461');assert.equal(t.listen,'127.0.0.1');assert.equal(t.db,options.database);assert.equal(t.usr,'postgres');
 const prior=JSON.parse(await fs.readFile(path.join(base,'migration-continuation-report.json'),'utf8'));
 assert.equal(prior.status,'PASS');assert.equal(prior.applied.length,4);
 const existing=(await admin.query("select 1 from pg_roles where rolname='ss_volume_runtime'")).rowCount;
 const verifyOnly=process.argv.includes('--verify-existing');
 assert.equal(existing,verifyOnly?1:0);
 const password=process.env.DISPOSABLE_RUNTIME_PASSWORD;
 assert.match(password,/^[A-Za-z0-9+/=]{48}$/);
 if(!verifyOnly) {
 await admin.query('begin');
 await admin.query(`CREATE ROLE ss_volume_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
 REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
 REVOKE CONNECT ON DATABASE smart_storage_gateway_test FROM PUBLIC;
 GRANT CONNECT ON DATABASE smart_storage_gateway_test TO ss_volume_runtime;
 GRANT ss_volume_gateway TO ss_volume_runtime WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
 ALTER ROLE ss_volume_runtime IN DATABASE smart_storage_gateway_test SET search_path='';`);
 await admin.query(`ALTER ROLE ss_volume_runtime PASSWORD ${pg.escapeLiteral(password)}`);
 await admin.query('commit');
 }
 report.loginCreated=true;
 runtime=new pg.Client({...options,user:'ss_volume_runtime',password});
 await runtime.connect();
 const {rows:[identity]}=await runtime.query(`select current_user=session_user and session_user='ss_volume_runtime' and inet_server_port()=55461 and current_database()='smart_storage_gateway_test' and not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) and rolcanlogin as restricted, current_setting('search_path')='""' and cardinality(current_schemas(false))=0 as empty_path from pg_roles where rolname=session_user`);
 assert.ok(identity.restricted && identity.empty_path);
 const {rows:members}=await runtime.query(`select r.rolname,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles r on r.oid=m.roleid where m.member=(select oid from pg_roles where rolname=session_user)`);
 assert.deepEqual(members,[{rolname:'ss_volume_gateway',admin_option:false,inherit_option:false,set_option:true}]);
 async function noTables() {
  const {rows:[r]}=await runtime.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private','auth') and c.relkind in ('r','p','v','m','f') and has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`);
  assert.equal(r.n,0);
 }
 await noTables();
 assert.equal((await runtime.query("select has_function_privilege(current_user,'public.ss_volume_command(uuid,text,uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
 await runtime.query('begin read only');await runtime.query('set local role ss_volume_gateway');
 await noTables();
 assert.equal((await runtime.query("select has_function_privilege(current_user,'public.ss_volume_command(uuid,text,uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed,true);
 await runtime.query('rollback');
 // Exercise actual denial paths without changing any data.
 for(const sql of ['select * from public.profiles limit 0','create table public.disposable_permission_probe(id int)','set role postgres']) {
  let denied=false;
  await runtime.query('begin');
  try {await runtime.query(sql);} catch(e) {assert.equal(e.code,'42501');denied=true;} finally {await runtime.query('rollback');}
  assert.ok(denied);
 }
 const deniedDb=new pg.Client({...options,database:'postgres',user:'ss_volume_runtime',password});
 let denied=false;try{await deniedDb.connect();}catch(e){assert.ok(['28000','42501'].includes(e.code));denied=true;}finally{await deniedDb.end().catch(()=>{});}assert.ok(denied);
 report.accessVerification='PASS: restricted identity, sole SET-only gateway membership, empty search_path, function-only access, table/DDL/admin-role/other-database denial';
 // Read-only evaluation of the exact predecessor guards; no provisioning DDL or allocation.
 const {rows:[compat]}=await admin.query(`select
 exists(select from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_id_fkey' and contype='f' and confrelid='auth.users'::regclass and pg_get_constraintdef(oid)='FOREIGN KEY (id) REFERENCES auth.users(id)') as profile_fk,
 exists(select from pg_proc where oid='public.ss_volume_command(uuid,text,uuid,jsonb)'::regprocedure and proowner=(select oid from pg_roles where rolname='postgres') and prosecdef and proconfig=array['search_path=""'] and md5(prosrc) in ('ef81771757b833c0a9688b977f63bcef','3b216cdc26d1b295e0eafe3d60d8f9f4')) as exact_function_guard,
 to_regclass('app_private.local_principals') is null as provisioning_not_installed,
 (select count(*)=0 from public.profiles) as no_accounts`);
 report.provisioningGuards=compat;
 report.provisioningSqlExecuted=false;
 report.status=Object.values(compat).every(Boolean)?'PASS_PREDECESSOR_GUARDS_ONLY':'BLOCKED_PROVISIONING_COMPATIBILITY';
} catch(e) {
 await admin.query('rollback').catch(()=>{});
 report.status='STOPPED';report.failure={code:e.code??'LOCAL_CHECK_FAILED'};process.exitCode=1;
} finally {
 await runtime?.end().catch(()=>{});await admin.end().catch(()=>{});
 await fs.writeFile(path.join(base,'runtime-login-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}
