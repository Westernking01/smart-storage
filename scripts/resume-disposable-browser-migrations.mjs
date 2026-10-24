import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readMigrationSql } from './read-migration-sql.mjs';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.cache/browser-roundtrip-20261020');
const report = { applied: [], accountProvisioning: 'not attempted', transfersEnabled: false, adr041: 'OPEN' };
let ownsReport = false;
const client = new pg.Client({host:'127.0.0.1', port:55461, database:'smart_storage_gateway_test', user:'postgres', password:process.env.DISPOSABLE_ADMIN_PASSWORD});
try {
  const prior = JSON.parse(await fs.readFile(path.join(base,'preparation-report.json'),'utf8'));
  const files = (await fs.readdir(path.join(root,'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort();
  assert.equal(files.length,11);
  assert.deepEqual(prior.migrations,files.slice(0,7));
  assert.equal(prior.currentMigration,files[7]);
  // Exclusive output creation prevents replay after a partial/complete continuation.
  await fs.writeFile(path.join(base,'migration-continuation-report.json'),JSON.stringify({status:'started; inspect before continuation'}),{flag:'wx'});
  ownsReport = true;
  await client.connect();
  const {rows:[target]} = await client.query("select current_database() db,current_user usr,current_setting('data_directory') dir,current_setting('port') port,current_setting('listen_addresses') listen,current_setting('server_version_num') version");
  assert.equal(path.resolve(target.dir).toLowerCase(),path.join(base,'postgres').toLowerCase());
  assert.equal(target.db,'smart_storage_gateway_test'); assert.equal(target.usr,'postgres');
  assert.equal(target.port,'55461'); assert.equal(target.listen,'127.0.0.1');
  assert.equal(Math.floor(Number(target.version)/10000),17);
  report.targetVerified=true;
  const {rows:[absence]} = await client.query(`select
    to_regclass('app_private.gateway_write_observations') is null as table_absent,
    not exists(select from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ss_gateway_record_write_observation_v1') as function_absent,
    not exists(select from pg_trigger where tgname='gateway_write_observations_immutable') as trigger_absent,
    not exists(select from pg_proc where proname in ('ss_gateway_resolve_dispatch_v1','gateway_enroll_reservation','ss_volume_command')) as later_functions_absent,
    not exists(select from pg_roles where rolname='ss_volume_gateway') as later_role_absent`);
  assert.ok(Object.values(absence).every(v=>v===true));
  report.preMigrationAbsence=absence;
  for(const file of files.slice(7)) {
    report.currentMigration=file;
    const location=path.join(root,'supabase/migrations',file);
    const original=await fs.readFile(location,'utf8');
    const sql=await readMigrationSql(location);
    assert.equal(sql,original.startsWith('\uFEFF')?original.slice(1):original);
    assert.match(sql,/\bbegin;/i); assert.match(sql,/commit;\s*$/i);
    await client.query(sql);
    report.applied.push(file);
    await fs.writeFile(path.join(base,'migration-continuation-report.json'),JSON.stringify(report,null,2));
  }
  delete report.currentMigration;
  await client.query('begin read only');
  const {rows:[checks]} = await client.query(`select
    (select count(*)=5 and bool_and(relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relname in ('volume_sessions','volume_objects','volume_settlements','volume_deletions','volume_readers')) as volume_rls,
    (select not rolcanlogin and not rolsuper and not rolinherit and not rolbypassrls from pg_roles where rolname='ss_volume_gateway') as gateway_restricted,
    has_function_privilege('ss_volume_gateway','public.ss_volume_command(uuid,text,uuid,jsonb)','execute') as gateway_execute,
    not has_function_privilege('authenticated','public.ss_volume_command(uuid,text,uuid,jsonb)','execute') as ordinary_execute_denied,
    not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private','auth') and c.relkind in ('r','p') and has_table_privilege('ss_volume_gateway',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as gateway_direct_tables_denied,
    exists(select from pg_trigger where tgname='gateway_reservation_admission' and tgenabled='O') as admission_trigger,
    (select count(*)=0 from public.profiles) as no_accounts,
    not exists(select from pg_roles where rolname='ss_volume_runtime') as runtime_login_not_created`);
  assert.ok(Object.values(checks).every(v=>v===true));
  report.compatibility=checks;
  await client.query('rollback');
  report.status='PASS';
} catch(error) {
  await client.query('rollback').catch(()=>{});
  report.status='STOPPED';
  report.failure={code:error.code??'LOCAL_CHECK_FAILED',message:/^[A-Z_]+$/.test(error.message)?error.message:'Migration or focused verification failed; no retry'};
  process.exitCode=1;
} finally {
  await client.end().catch(()=>{});
  if (ownsReport) await fs.writeFile(path.join(base,'migration-continuation-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
