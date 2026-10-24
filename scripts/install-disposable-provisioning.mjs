import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const base=path.join(root,'.cache/browser-roundtrip-20261020');
const report={status:'STARTED',installed:false,accountProvisioning:'not attempted',runtimeActive:false,transfersEnabled:false,adr041:'OPEN',checks:[]};
const options={host:'127.0.0.1',port:55461,database:'smart_storage_gateway_test'};
const admin=new pg.Client({...options,user:'postgres',password:process.env.DISPOSABLE_ADMIN_PASSWORD});
let runtime,ownsReport=false;
const reportPath=path.join(base,'provisioning-install-report.json');
async function check(name,sql){const {rows:[r]}=await admin.query(sql);assert.ok(Object.values(r).every(x=>x===true),name);report.checks.push(name);}
try {
 await admin.connect();
 const {rows:[t]}=await admin.query("select current_database() db,current_user usr,current_setting('data_directory') dir,current_setting('port') port,current_setting('listen_addresses') listen,current_setting('server_version_num') version,host(inet_server_addr()) addr");
 assert.equal(path.resolve(t.dir).toLowerCase(),path.join(base,'postgres').toLowerCase());
 assert.equal(t.db,options.database);assert.equal(t.usr,'postgres');assert.equal(t.port,'55461');assert.equal(t.listen,'127.0.0.1');assert.equal(t.addr,'127.0.0.1');assert.equal(Math.floor(Number(t.version)/10000),17);
 report.target=t;
 await fs.writeFile(reportPath,JSON.stringify(report),{flag:'wx'});ownsReport=true;
 assert.equal(JSON.parse(await fs.readFile(path.join(base,'migration-continuation-report.json'),'utf8')).status,'PASS');
 await check('empty uninstalled schema and predecessor',`select to_regclass('app_private.local_principals') is null absent,
 not exists(select from public.profiles) and not exists(select from public.user_usage) and not exists(select from auth.users) empty,
 exists(select from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_id_fkey' and contype='f' and confrelid='auth.users'::regclass and pg_get_constraintdef(oid)='FOREIGN KEY (id) REFERENCES auth.users(id)') fk,
 exists(select from pg_proc where oid='public.ss_volume_command(uuid,text,uuid,jsonb)'::regprocedure and proowner=(select oid from pg_roles where rolname='postgres') and prosecdef and proconfig=array['search_path=""'] and md5(prosrc) in ('ef81771757b833c0a9688b977f63bcef','3b216cdc26d1b295e0eafe3d60d8f9f4')) command,
 (select count(*)=5 from pg_roles where rolname in ('anon','authenticated','service_role','ss_volume_gateway','ss_volume_runtime')) roles,
 to_regclass('public.user_usage') is not null usage`);
 const before=(await admin.query(`select proowner,proacl::text,prosecdef,proconfig,prosrc from pg_proc where oid='public.ss_volume_command(uuid,text,uuid,jsonb)'::regprocedure`)).rows[0];
 const triggers=(await admin.query(`select oid,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by oid`)).rows;
 const securitySql=`select
 not exists(select from pg_roles where rolname in ('ss_volume_gateway','ss_volume_runtime') and (rolsuper or rolinherit or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication)) restricted,
 (select count(*)=1 and bool_and(not m.admin_option and not m.inherit_option and m.set_option and r.rolname='ss_volume_gateway') from pg_auth_members m join pg_roles r on r.oid=m.roleid where m.member=(select oid from pg_roles where rolname='ss_volume_runtime')) membership,
 not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join (values ('ss_volume_gateway'),('ss_volume_runtime')) r(role) where n.nspname in ('public','app_private','auth') and c.relkind in ('r','p') and has_table_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) no_direct_tables,
 (select count(*)=5 and bool_and(relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relname in ('volume_sessions','volume_objects','volume_settlements','volume_deletions','volume_readers')) volume_rls,
 exists(select from pg_trigger where tgname='gateway_reservation_admission' and tgenabled='O') admission`;
 await check('pre-install roles permissions RLS admission',securitySql);
 const sqlBytes=await fs.readFile(path.join(root,'docs/local-account-provisioning.sql'));
 report.sqlSha256=crypto.createHash('sha256').update(sqlBytes).digest('hex');
 // Explicit target only; dump secrets never reach stdout or command arguments.
 const backup=path.join(base,'before-provisioning.dump');
 await fs.access(backup).then(()=>{throw Error('BACKUP_EXISTS');},e=>{if(e.code!=='ENOENT')throw e;});
 execFileSync('C:/Program Files/PostgreSQL/17/bin/pg_dump.exe',['-h','127.0.0.1','-p','55461','-U','postgres','-d',options.database,'-Fc','-f',backup],{env:{...process.env,PGPASSWORD:process.env.DISPOSABLE_ADMIN_PASSWORD},stdio:'pipe'});
 assert.ok((await fs.stat(backup)).size>0);report.backup='before-provisioning.dump';
 report.installAttempted=true;
 await admin.query(sqlBytes.toString('utf8'));report.installed=true;
 const after=(await admin.query(`select proowner,proacl::text,prosecdef,proconfig,prosrc from pg_proc where oid='public.ss_volume_command(uuid,text,uuid,jsonb)'::regprocedure`)).rows[0];
 const insertion="begin\n perform 1 from app_private.local_principals where id=p_owner and subject=p_owner\n and state='active' and issuer=current_setting('smart_storage.local_issuer',true)\n and issuer='https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1' for share;\n if not found then raise exception 'ACCOUNT_SETUP_REQUIRED'; end if;\n if p_action='binding' then return 'true'::jsonb; end if;\n";
 assert.equal(after.prosrc,before.prosrc.replaceAll('begin\n',insertion));
 for(const k of ['proowner','proacl','prosecdef','proconfig'])assert.deepEqual(after[k],before[k]);
 assert.deepEqual((await admin.query(`select oid,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by oid`)).rows,triggers);
 report.checks.push('exact guarded patch; command owner ACL search_path and custom triggers preserved');
 await check('post-install security',securitySql);
 await check('operator-only provisioning and private RLS registry',`select
 exists(select from pg_class where oid='app_private.local_principals'::regclass and relrowsecurity and relowner=(select oid from pg_roles where rolname='postgres')) rls,
 exists(select from pg_proc where oid='app_private.provision_local_account(text,uuid,bigint,integer)'::regprocedure and not prosecdef and proconfig=array['search_path=""'] and proowner=(select oid from pg_roles where rolname='postgres')) invoker,
 not exists(select from pg_roles where not rolsuper and rolname<>'postgres' and (has_function_privilege(oid,'app_private.provision_local_account(text,uuid,bigint,integer)','EXECUTE') or (rolname not in ('pg_read_all_data','pg_write_all_data') and has_table_privilege(oid,'app_private.local_principals','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))) authority,
 exists(select from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_id_fkey' and confrelid='app_private.local_principals'::regclass and convalidated) fk,
 not exists(select from public.profiles) and not exists(select from public.user_usage) and not exists(select from app_private.local_principals) and not exists(select from auth.users) empty`);
 async function denied(client,sql,params,expected){await client.query('begin');try{await client.query(sql,params);assert.fail('EXPECTED_DENIAL');}catch(e){assert.equal(e.code,expected.code);if(expected.message)assert.equal(e.message,expected.message);}finally{await client.query('rollback');}}
 // Null subject guarantees these negative probes cannot allocate any principal.
 for(const args of [[null,null,262144,1],['https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1',null,262144,1]])await denied(admin,'select app_private.provision_local_account($1,$2,$3,$4)',args,{code:'P0001',message:'INVALID_PROVISIONING_MANIFEST'});
 runtime=new pg.Client({...options,user:'ss_volume_runtime',password:process.env.DISPOSABLE_RUNTIME_PASSWORD});await runtime.connect();
 await denied(runtime,'select app_private.provision_local_account(null,null,0,0)',[],{code:'42501'});
 await runtime.query('begin');await runtime.query('set local role ss_volume_gateway');
 assert.equal((await runtime.query("select has_function_privilege(current_user,'public.ss_volume_command(uuid,text,uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed,true);
 await runtime.query('rollback');
 for(const issuer of ['', 'https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1']){
  await runtime.query('begin');await runtime.query('set local role ss_volume_gateway');
  await runtime.query("select set_config('smart_storage.local_issuer',$1,true)",[issuer]);
  try{await runtime.query("select public.ss_volume_command('00000000-0000-4000-8000-000000000001','binding',null,'{}')");assert.fail('EXPECTED_DENIAL');}catch(e){assert.equal(e.message,'ACCOUNT_SETUP_REQUIRED');}finally{await runtime.query('rollback');}
 }
 report.checks.push('invalid manifests denied without subject; runtime provisioning denied; missing-binding command denied with absent/correct issuer');
 await check('no account or Auth rows created',`select not exists(select from app_private.local_principals) and not exists(select from public.profiles) and not exists(select from public.user_usage) and not exists(select from auth.users) empty`);
 assert.deepEqual(await fs.readFile(path.join(root,'docs/local-account-provisioning.sql')),sqlBytes);
 report.status='PASS';
}catch(e){await admin.query('rollback').catch(()=>{});report.status='STOPPED';report.failure={code:e.code??'LOCAL_ASSERTION',message:e instanceof assert.AssertionError?e.message:(/^[A-Z_]+$/.test(e.message)?e.message:'Installation or focused verification failed; inspect privately before retry')};process.exitCode=1;}
finally{await runtime?.end().catch(()=>{});await admin.end().catch(()=>{});if(ownsReport)await fs.writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}

