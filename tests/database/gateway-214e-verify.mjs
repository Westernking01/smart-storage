import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const evidence = JSON.parse(
  readFileSync("tests/database/gateway-214e-results.json", "utf8"),
);
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
env.PGPASSFILE = "C:/ProgramData/SmartStoragePgTest/pgpass.conf";
const run = (input) => {
  const r = spawnSync(
    "C:/Program Files/PostgreSQL/17/bin/psql.exe",
    [
      "-X",
      "-w",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
      "-U",
      "postgres",
      "-d",
      "smart_storage_gateway_test",
    ],
    { input, env, encoding: "utf8", timeout: 15000 },
  );
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr);
  return r.stdout.trim();
};
const check = (q, message) => {
  if (run(q) !== "t") throw new Error(message);
};
check(
  `begin read only; set local role authenticated;
set local request.jwt.claims='{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
select (select count(*)=2 and bool_and(owner_id='00000000-0000-0000-0000-000000000001') from public.files)
and (select count(*)=1 from public.profiles) and (select count(*)=2 from public.upload_sessions); rollback;`,
  "Owner RLS failed",
);
check(
  `begin read only; set local role authenticated;
set local request.jwt.claims='{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}';
select (select count(*)=2 and bool_and(owner_id='00000000-0000-0000-0000-000000000002') from public.files)
and (select count(*)=0 from public.files where owner_id='00000000-0000-0000-0000-000000000001'); rollback;`,
  "Cross-owner RLS failed",
);
check(
  `select not exists(select from pg_auth_members m join pg_roles r on r.oid=m.roleid where r.rolname in ('anon','authenticated','service_role','ss_gateway_executor','ss_gateway_observer','ss_gateway_finalizer','ss_gateway_cleaner'));`,
  "Unexpected role membership",
);
check(
  `select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and ((n.nspname='app_private' and c.relname<>'account_policy') or (n.nspname='public' and c.relname !~ '^race[0-9]+_'));`,
  "Missing application RLS",
);
check(
  `select bool_and(not has_table_privilege(r.oid,'app_private.account_policy','SELECT,INSERT,UPDATE,DELETE')) from pg_roles r where rolname in ('anon','authenticated','service_role','ss_gateway_executor','ss_gateway_observer','ss_gateway_finalizer','ss_gateway_cleaner');`,
  "Private policy privilege boundary failed",
);
check(
  `select not has_table_privilege('anon','public.files','SELECT') and not has_table_privilege('authenticated','public.files','INSERT') and not has_table_privilege('ss_gateway_executor','app_private.gateway_verifications','INSERT') and not has_table_privilege('ss_gateway_observer','app_private.gateway_verifications','INSERT') and not has_table_privilege('ss_gateway_cleaner','app_private.gateway_verifications','INSERT') and not has_table_privilege('ss_gateway_finalizer','app_private.gateway_verifications','INSERT') and not has_function_privilege('authenticated','public.ss_gateway_claim_v1(uuid,uuid,uuid,bigint,uuid)','EXECUTE');`,
  "Unexpected runtime privilege",
);
const inventory = JSON.parse(
  run(`select json_build_object(
'database',current_database(),'version',current_setting('server_version'),
'schemas',(select json_agg(nspname order by nspname) from pg_namespace where nspname in ('auth','public','app_private')),
'relations',(select json_agg(json_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','public','app_private')),
'functions',(select json_agg(json_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'config',p.proconfig) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('auth','public','app_private')),
'triggers',(select json_agg(json_build_object('table',tgrelid::regclass::text,'name',tgname) order by tgrelid::regclass::text,tgname) from pg_trigger where not tgisinternal),
'policies',(select json_agg(to_jsonb(p)) from pg_policies p where schemaname in ('auth','public','app_private')),
'fixtures',(select json_build_object('synthetic_users',(select count(*) from auth.users),'files',(select count(*) from public.files),'sessions',(select count(*) from public.upload_sessions),'fixture_namespace_max',max(substring(id::text,7,2)::integer)) from auth.users));`),
);
writeFileSync(
  "tests/database/gateway-214e-inventory.json",
  JSON.stringify(inventory, null, 2) + "\n",
);
evidence.security = {
  ownerRls: "PASS",
  crossOwnerRls: "PASS",
  applicationRlsEnabled: "PASS",
  privatePolicyException:
    "account_policy has no RLS; all seven runtime roles lack SELECT/INSERT/UPDATE/DELETE privileges",
  runtimePrivilegeDenials: "PASS",
  roleMemberships: "NONE",
  syntheticAuthOnly: true,
};
evidence.migrationSha256 = Object.fromEntries(
  evidence.migrations.map((n) => [
    n,
    createHash("sha256")
      .update(readFileSync(`supabase/migrations/${n}`))
      .digest("hex"),
  ]),
);
evidence.inventory = "tests/database/gateway-214e-inventory.json";
writeFileSync(
  "tests/database/gateway-214e-results.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "PASS owner/cross-owner RLS, runtime privileges, application RLS and no role memberships; inventory saved",
);
