// Uses the established psql credential mechanism; never reads passfile contents.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const mode = process.argv[2];
if (!['--catalog-only', '--interactive'].includes(mode)) throw Error('EXPLICIT_MODE_REQUIRED');
const observer = mode === '--interactive';
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('PG')) delete env[k];
env.PGCONNECT_TIMEOUT = '3';
env.PGPASSFILE = observer ? 'NUL' : 'C:/ProgramData/SmartStoragePgTest/pgpass.conf';
const output = observer ? 'tests/database/seeded-fixture-observer-postinstall.log' : 'tests/database/seeded-fixture-postinstall.log';
const args = ['-X', observer ? '-W' : '-w', '-v', 'ON_ERROR_STOP=1',
 '-h','127.0.0.1','-p','5432','-U',observer ? 'ss_gateway_observer_runtime_test' : 'postgres',
 '-d','smart_storage_gateway_test', '-L',output,'-f', observer
 ? 'tests/database/seeded-fixture-observer-postinstall.sql' : 'tests/database/seeded-fixture-postinstall.sql'];
const r = spawnSync('C:/Program Files/PostgreSQL/17/bin/psql.exe',args,
 { env, stdio: observer ? 'inherit' : 'pipe', encoding:'utf8',timeout:observer ? 300000 : 15000 });
const result = { at:new Date().toISOString(), mode, exitCode:r.status,
 status:r.status===0 ? 'COMPLETED_REVIEW_CHECK_ROWS' : 'BLOCKED_OR_FAILED',
 error:r.error?.code ?? null, providerRequests:0, credentialContentsRead:false, fixtureRegistration:false };
writeFileSync(output+'.json',JSON.stringify(result,null,2)+'\n');
if (!observer) { process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); }
process.exitCode = r.status===0 ? 0 : 1;
