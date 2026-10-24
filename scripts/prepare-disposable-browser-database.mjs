import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readMigrationSql } from './read-migration-sql.mjs';
const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.cache/browser-roundtrip-20261020');
const report = { clusterVerified: false, migrations: [], provisioning: 'not attempted', account: 'unbound; fresh ordinary Auth verification required', transfersEnabled: false, adr041: 'OPEN' };
let client;
try {
  client = new pg.Client({ host:'127.0.0.1',port:55461,user:'postgres',database:'postgres',password:process.env.DISPOSABLE_ADMIN_PASSWORD });
  await client.connect();
  const {rows:[r]} = await client.query("select current_setting('data_directory') dir,current_setting('port') port,current_setting('listen_addresses') listen");
  if(path.resolve(r.dir).toLowerCase()!==path.join(base,'postgres').toLowerCase() || r.port!=='55461' || r.listen!=='127.0.0.1') throw Error('CLUSTER_TARGET_MISMATCH');
  report.clusterVerified=true;
  await client.query('CREATE DATABASE smart_storage_gateway_test');
  await client.end();
  client = new pg.Client({host:'127.0.0.1',port:55461,user:'postgres',database:'smart_storage_gateway_test',password:process.env.DISPOSABLE_ADMIN_PASSWORD});
  await client.connect();
  await client.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
  const files=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort();
  if(files.length!==11) throw Error('MIGRATION_INVENTORY_CHANGED');
  for(const file of files){
    report.currentMigration=file;
    await client.query(await readMigrationSql(path.join(root,'supabase/migrations',file)));
    report.migrations.push(file);
  }
  delete report.currentMigration;
  await client.query(`CREATE ROLE ss_volume_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
REVOKE CONNECT ON DATABASE smart_storage_gateway_test FROM PUBLIC;
GRANT CONNECT ON DATABASE smart_storage_gateway_test TO ss_volume_runtime;
GRANT ss_volume_gateway TO ss_volume_runtime WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER ROLE ss_volume_runtime IN DATABASE smart_storage_gateway_test SET search_path='';`);
  const password=process.env.DISPOSABLE_RUNTIME_PASSWORD;
  if(!/^[A-Za-z0-9+/=]+$/.test(password))throw Error('PASSWORD_FORMAT');
  await client.query(`ALTER ROLE ss_volume_runtime PASSWORD '${password}'`);
  report.provisioning='checking unchanged guarded SQL';
  await client.query(await fs.readFile(path.join(root,'docs/local-account-provisioning.sql'),'utf8'));
  report.provisioning='compatible';
} catch(error) {
  // SQL text, connection strings and server detail must never be reported.
  report.failure={code:error.code ?? 'LOCAL_SETUP_FAILURE',message:/^[A-Z_]+$/.test(error.message)?error.message:'Database operation failed; inspect compatibility privately'};
  process.exitCode=1;
} finally {
  if(client)await client.end().catch(()=>{});
  await fs.writeFile(path.join(base,'preparation-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
