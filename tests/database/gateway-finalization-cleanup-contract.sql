-- Serial relational contract tests. Administrator-inserted verification fixtures
-- exercise SQL only; they are NOT actual provider validation or approved evidence.
begin;
create function public.final_assert(ok boolean) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION_FAILED'; end if; end $$;
create function public.final_error(statement text,expected text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then if position(expected in sqlerrm)>0 then return; end if; raise; end;
 raise exception 'EXPECTED_ERROR: %',expected;
end $$;
select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',8,'60000000-0000-0000-0000-000000000001');

create function public.final_register(n integer,kind text,path text,parent uuid default null) returns uuid language sql as $$
 select public.ss_gateway_register_resource_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',
 ('70000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,1,kind,path,
 '{"namespace":"sql-fixture-only","uploadId":null,"version":"immutable-fixture-v1","generation":null}',case when kind='manifest' then 1024 else 8 end,parent)
$$;
select public.final_register(1,'object',(select object_path from public.transfer_attempts where id='40000000-0000-0000-0000-000000000001'));
select public.final_register(2,'manifest','local/10000000-0000-0000-0000-000000000001/manifest');
select public.final_register(3,'temporary','fixture-temp','70000000-0000-0000-0000-000000000001');
select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',1);
insert into app_private.gateway_protocols values('90000000-0000-0000-0000-000000000001','sql-fixture-only','not-a-provider-protocol','fixture-only',repeat('b',64));
create function public.final_manifest() returns bytea language sql as $$
 select convert_to(jsonb_build_object('format','compression-spike','version',1,'blockSize',8388608,'originalBytes',8,
 'originalSha256',repeat('a',64),'blocks',jsonb_build_array(jsonb_build_object('index',0,'offset',0,'originalBytes',8,
 'encodedBytes',8,'codec','raw','originalSha256',repeat('a',64),'encodedSha256',repeat('a',64))))::text,'UTF8')
$$;
-- Test-only privileged fixture importer. Rolled back; never part of migration.
create function public.final_cert(kind text,rid uuid default null,bytes bigint default 8,terminal uuid default null)
returns uuid language plpgsql as $$
#variable_conflict use_variable
declare cert_id uuid:=gen_random_uuid(); obs uuid; ep bigint; begin
 select epoch into ep from public.upload_sessions where id='20000000-0000-0000-0000-000000000001';
 if kind in ('present','absence','manifest') then
  select public.ss_gateway_record_receipt_v1('00000000-0000-0000-0000-000000000001',rid,gen_random_uuid(),1,
  jsonb_build_object('scope',r.scope,'kind',case when kind='absence' then 'absence' else 'inspection' end,
  'outcome',case when kind='absence' then 'absent' else 'present' end,'observedBytes',case when kind='absence' then null else bytes end,
  'observedAt',clock_timestamp(),'provenance',jsonb_build_object('fixture','SQL ONLY'),'verifierRevision','SQL ONLY')) into obs
  from app_private.gateway_resources r where r.resource_id=rid;
 end if;
 insert into app_private.gateway_verifications(verification_id,protocol_id,owner_id,session_id,decision_epoch,membership_digest,kind,
 resource_id,observation_id,terminal_id,writer_digest,content_sha256,accepted_bytes,acknowledged_bytes,serialized_manifest,
 evidence_reference,evidence_sha256,barrier_reference)
 values(cert_id,'90000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
 ep,app_private.gateway_membership_digest('20000000-0000-0000-0000-000000000001'),kind,rid,obs,terminal,
 app_private.gateway_writer_digest('20000000-0000-0000-0000-000000000001'),case when kind='manifest' then encode(sha256(public.final_manifest()),'hex') else repeat('a',64) end,
 bytes,bytes,case when kind='manifest' then public.final_manifest() end,'SQL FIXTURE ONLY',repeat('c',64),'SQL FIXTURE NOT PROVIDER CAUSALITY');
 return cert_id;
end $$;
create temp table certs(kind text,rid uuid,id uuid);
insert into certs select 'membership',null,public.final_cert('membership');
insert into certs select 'terminal',resource_id,public.final_cert('terminal',resource_id) from app_private.gateway_resources;
insert into certs select case r.kind when 'object' then 'present' when 'manifest' then 'manifest' else 'absence' end,r.resource_id,
 public.final_cert(case r.kind when 'object' then 'present' when 'manifest' then 'manifest' else 'absence' end,r.resource_id,
 case when r.kind='manifest' then octet_length(public.final_manifest()) else 8 end,t.id)
 from app_private.gateway_resources r join certs t on t.rid=r.resource_id and t.kind='terminal';
-- Under 007 the manifest must have a genuine consumed writer grant. Earlier
-- migration regression runs retain their original fixture behavior.
do $$ begin
 if to_regprocedure('public.ss_gateway_complete_stream_v1(uuid,uuid,bigint,uuid,uuid,uuid,uuid)') is not null then
  perform public.ss_gateway_complete_stream_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',1,
   gen_random_uuid(),'70000000-0000-0000-0000-000000000001',(select id from certs where kind='present'),
   (select id from certs where kind='terminal' and rid='70000000-0000-0000-0000-000000000001'));
  perform public.ss_gateway_claim_resource_v1('00000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002',
   '50000000-0000-0000-0000-000000000012',1,octet_length(public.final_manifest()),'60000000-0000-0000-0000-000000000001');
  perform public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000001',1);
  truncate certs;
  insert into certs select 'membership',null,public.final_cert('membership');
  insert into certs select 'terminal',resource_id,public.final_cert('terminal',resource_id) from app_private.gateway_resources;
  insert into certs select case r.kind when 'object' then 'present' when 'manifest' then 'manifest' else 'absence' end,r.resource_id,
   public.final_cert(case r.kind when 'object' then 'present' when 'manifest' then 'manifest' else 'absence' end,r.resource_id,
   case when r.kind='manifest' then octet_length(public.final_manifest()) else 8 end,t.id)
   from app_private.gateway_resources r join certs t on t.rid=r.resource_id and t.kind='terminal';
 end if;
end $$;
create function public.final_prepare(epoch bigint default 1,selection jsonb default null) returns uuid language sql as $$
 select public.ss_gateway_prepare_finalization_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
 'a0000000-0000-0000-0000-000000000001',epoch,
 coalesce(selection,(select jsonb_agg(jsonb_build_object('resourceId',rid,'verificationId',id)) from certs where kind='present')),
 (select id from certs where kind='manifest'),(select id from certs where kind='membership'),8)
$$;
-- 2 missing block; 4 stale epoch; forged resource and receipt IDs.
select public.final_error($q$select public.final_prepare(selection=>'[]')$q$,'BLOCKS_INCOMPLETE');
select public.final_error('select public.final_prepare(epoch=>2)','STALE_EPOCH');
select public.final_error($q$select public.final_prepare(selection=>'[{"resourceId":"70000000-0000-0000-0000-000000000002","verificationId":"a0000000-0000-0000-0000-000000000099"}]')$q$,'BLOCK_EVIDENCE_INVALID');
-- 3 mismatched size. Later observation must not make older success usable.
savepoint wrong_size;
insert into certs select 'wrong',rid,public.final_cert('present',rid,9,(select id from certs where kind='terminal' and rid=c.rid)) from certs c where kind='present';
select public.final_error($q$select public.final_prepare(selection=>(select jsonb_agg(jsonb_build_object('resourceId',rid,'verificationId',id)) from certs where kind='wrong'))$q$,'SIZE_OR_HASH_MISMATCH');
rollback to wrong_size;
-- 5 ambiguous observation after the selected receipt blocks preparation.
savepoint ambiguous;
select public.ss_gateway_record_receipt_v1('00000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001',gen_random_uuid(),1,
 jsonb_build_object('scope',(select scope from app_private.gateway_resources where kind='object'),'kind','timeout','outcome','ambiguous',
 'observedBytes',null,'observedAt',clock_timestamp(),'provenance','{}'::jsonb,'verifierRevision','SQL ONLY'));
select public.final_error('select public.final_prepare()','OBSERVATION_AMBIGUOUS');
rollback to ambiguous;
-- Unprovisioned capability, absent terminal, and forged protocol cannot prepare.
savepoint no_capability;
insert into app_private.gateway_invalidations values(gen_random_uuid(),'20000000-0000-0000-0000-000000000001','SQL quarantine',default);
select public.final_error('select public.final_prepare()','EVIDENCE_QUARANTINED');
rollback to no_capability;
-- Provisional observations cannot replace sealed trusted records.
select public.final_error($q$select public.ss_gateway_prepare_finalization_v1('00000000-0000-0000-0000-000000000001',
'20000000-0000-0000-0000-000000000001',gen_random_uuid(),1,
(select jsonb_agg(jsonb_build_object('resourceId',rid,'verificationId',id)) from certs where kind='present'),
(select id from certs where kind='manifest'),gen_random_uuid(),8)$q$,'EVIDENCE_REQUIRED');
select public.final_error($q$select public.final_prepare(selection=>(select jsonb_agg(jsonb_build_object('resourceId',rid,'verificationId',id))||jsonb_agg(jsonb_build_object('resourceId',rid,'verificationId',id)) from certs where kind='present'))$q$,'BLOCKS_INCOMPLETE');
savepoint changed_membership;
select public.final_register(4,'part','new-part','70000000-0000-0000-0000-000000000003');
select public.final_error('select public.final_prepare()','MEMBERSHIP_CHANGED');
rollback to changed_membership;
-- 1 valid relational evidence; 6 exact duplicate. Prepared is never ready/cloud complete.
savepoint prepared;
grant select on certs to ss_gateway_finalizer;
set local role ss_gateway_finalizer;
select public.final_assert(public.final_prepare()=public.final_prepare());
reset role;
select public.final_assert((select state='uploading' and held_bytes=131080 and slot_held from public.upload_sessions where id='20000000-0000-0000-0000-000000000001'));
select public.final_assert((select state='uploading' from public.files where id='10000000-0000-0000-0000-000000000001'));
select public.final_assert((select count(*)=0 from public.file_manifests));
select public.final_error($q$select public.final_prepare(epoch=>2)$q$,'IDEMPOTENCY_CONFLICT');
rollback to prepared;
-- 7 Missing historical allocation membership blocks cleanup settlement.
savepoint missing_member;
insert into public.transfer_attempts(id,block_id,session_id,owner_id,epoch,object_path,authorized_max_bytes,expires_at,attempt_number)
values(gen_random_uuid(),'30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
'00000000-0000-0000-0000-000000000001',1,'missing-old-allocation',8,clock_timestamp()+interval '1 day',2);
create temp table missing_job as select public.ss_gateway_begin_cleanup_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001') id;
select public.ss_gateway_lease_cleanup_v1('00000000-0000-0000-0000-000000000001',(select id from missing_job));
select public.final_error($q$select public.ss_gateway_settle_cleanup_v1('00000000-0000-0000-0000-000000000001',(select id from missing_job),1,gen_random_uuid(),(select id from certs where kind='membership'))$q$,'MEMBERSHIP_INCOMPLETE');
rollback to missing_member;
create temp table job as select public.ss_gateway_begin_cleanup_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001') id;
select public.final_assert((select id from job)=public.ss_gateway_begin_cleanup_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'));
select public.final_assert((select count(*)=3 from app_private.gateway_cleanup_members));
select public.ss_gateway_lease_cleanup_v1('00000000-0000-0000-0000-000000000001',(select id from job));
-- Prior epoch certificates are not current cleanup authority.
select public.final_error($q$select public.ss_gateway_record_removal_v1('00000000-0000-0000-0000-000000000001',(select id from job),1,
'70000000-0000-0000-0000-000000000003',(select id from certs where kind='terminal' and rid='70000000-0000-0000-0000-000000000003'),
(select id from certs where kind='absence'),gen_random_uuid())$q$,'STALE_EPOCH');
-- Current-epoch test-only imports, no real provider proof.
truncate certs;
insert into certs select 'membership',null,public.final_cert('membership');
insert into certs select 'terminal',resource_id,public.final_cert('terminal',resource_id) from app_private.gateway_resources;
insert into certs select 'absence',rid,public.final_cert('absence',rid,0,id) from certs where kind='terminal';
create function public.final_settle(owner_id uuid default '00000000-0000-0000-0000-000000000001',lease bigint default 1) returns jsonb language sql as $$
 select public.ss_gateway_settle_cleanup_v1(owner_id,(select id from job),lease,'a0000000-0000-0000-0000-000000000002',(select id from certs where kind='membership'))
$$;
-- 8 missing termination; 9 missing authoritative per-member absence.
select public.final_error($q$select public.ss_gateway_record_removal_v1('00000000-0000-0000-0000-000000000001',(select id from job),1,
'70000000-0000-0000-0000-000000000001',gen_random_uuid(),(select id from certs where kind='absence' and rid='70000000-0000-0000-0000-000000000001'),gen_random_uuid())$q$,'EVIDENCE_REQUIRED');
select public.final_error('select public.final_settle()','AUTHORITATIVE_ABSENCE_REQUIRED');
select public.final_assert((select reserved_bytes=262160 and active_slots=2 from public.user_usage where owner_id='00000000-0000-0000-0000-000000000001'));
-- 11 cross-account; stale lease.
select public.final_error($q$select public.final_settle('00000000-0000-0000-0000-000000000002')$q$,'FORBIDDEN');
select public.final_error('select public.final_settle(lease=>2)','STALE_LEASE');
select public.ss_gateway_record_removal_v1('00000000-0000-0000-0000-000000000001',(select id from job),1,a.rid,t.id,a.id,a.id)
 from certs a join certs t on t.rid=a.rid and t.kind='terminal' where a.kind='absence';
-- Exact duplicate removal is idempotent.
select public.ss_gateway_record_removal_v1('00000000-0000-0000-0000-000000000001',(select id from job),1,a.rid,t.id,a.id,a.id)
 from certs a join certs t on t.rid=a.rid and t.kind='terminal' where a.kind='absence';
-- Partial member coverage (temporary and object only) still retains capacity.
savepoint missing_manifest;
-- Removing the recorded decision is forbidden even to a worker; rollback is the
-- only fixture reset. Missing manifest evidence is exercised on a fresh lease.
update public.cleanup_jobs set lease_until=clock_timestamp()-interval '1 second' where id=(select id from job);
select public.ss_gateway_lease_cleanup_v1('00000000-0000-0000-0000-000000000001',(select id from job));
select public.ss_gateway_record_removal_v1('00000000-0000-0000-0000-000000000001',(select id from job),2,a.rid,t.id,a.id,gen_random_uuid())
 from certs a join certs t on t.rid=a.rid and t.kind='terminal' where a.kind='absence' and a.rid<>'70000000-0000-0000-0000-000000000002';
select public.final_error('select public.final_settle(lease=>2)','AUTHORITATIVE_ABSENCE_REQUIRED');
rollback to missing_manifest;
-- 12 Inconsistent accounting must abort every transition, then allow repair/retry.
savepoint negative;
update public.user_usage set reserved_bytes=0,active_slots=0 where owner_id='00000000-0000-0000-0000-000000000001';
select public.final_error('select public.final_settle()','ACCOUNTING_LIMIT');
select public.final_assert((select count(*)=0 from app_private.gateway_settlements));
select public.final_assert((select count(*)=0 from public.usage_events where event_key like 'settle:%'));
rollback to negative;
-- 10 Once only; a failed transaction must not free anything.
savepoint rollback_settle;
select public.final_settle();
rollback to rollback_settle;
select public.final_assert((select reserved_bytes=262160 and active_slots=2 from public.user_usage where owner_id='00000000-0000-0000-0000-000000000001'));
grant select on certs,job to ss_gateway_cleaner;
set local role ss_gateway_cleaner;
select public.final_assert(public.final_settle()=public.final_settle());
reset role;
select public.final_assert((select count(*)=1 from public.usage_events where event_key='settle:20000000-0000-0000-0000-000000000001'));
select public.final_assert((select reserved_bytes=131080 and active_slots=1 and stored_bytes=0 from public.user_usage where owner_id='00000000-0000-0000-0000-000000000001'));
select public.final_assert((select reserved_bytes=262160 and active_slots=2 from public.user_usage where owner_id='00000000-0000-0000-0000-000000000002'));
select public.final_assert((select state='settled' and held_bytes=0 and not slot_held from public.upload_sessions where id='20000000-0000-0000-0000-000000000001'));
-- Restricted roles cannot forge imports or call legacy boolean/proof releases.
select public.final_assert(not has_table_privilege('ss_gateway_observer','app_private.gateway_verifications','INSERT'));
select public.final_assert(not has_table_privilege('ss_gateway_cleaner','app_private.gateway_protocols','INSERT'));
set local role service_role;
select public.final_error($q$select public.ss_settle_cleanup('20000000-0000-0000-0000-000000000001',true,true)$q$,'GATEWAY_V1_REQUIRED');
reset role;
select public.final_assert((select not slot_held from app_private.gateway_requests where request_id='50000000-0000-0000-0000-000000000001'));
select public.final_assert(not has_function_privilege('authenticated','public.ss_gateway_settle_cleanup_v1(uuid,uuid,bigint,uuid,uuid)','EXECUTE'));
set local role authenticated;
select public.final_error($q$select public.ss_gateway_begin_cleanup_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001')$q$,'permission denied');
reset role;
rollback;
