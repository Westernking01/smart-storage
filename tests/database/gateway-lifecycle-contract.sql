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
select public.final_error($q$select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',1)$q$,'MEMBERSHIP_INCOMPLETE');
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
create function public.life_complete(ep bigint default 1,owner_id uuid default '00000000-0000-0000-0000-000000000001') returns uuid language sql as $$
 select public.ss_gateway_complete_stream_v1(owner_id,'50000000-0000-0000-0000-000000000001',ep,
 'a0000000-0000-0000-0000-000000000010','70000000-0000-0000-0000-000000000001',
 (select id from certs where kind='present'),(select id from certs where kind='terminal' and rid='70000000-0000-0000-0000-000000000001'))
$$;
create function public.life_claim(rid integer default 2,ep bigint default 1,owner_id uuid default '00000000-0000-0000-0000-000000000001') returns uuid language sql as $$
 select public.ss_gateway_claim_resource_v1(owner_id,('70000000-0000-0000-0000-'||lpad(rid::text,12,'0'))::uuid,
 ('50000000-0000-0000-0000-'||lpad((rid+10)::text,12,'0'))::uuid,ep,8,'60000000-0000-0000-0000-000000000001')
$$;
select public.final_error('select public.life_claim()','CAPACITY_EXCEEDED');
select public.ss_gateway_record_stream_outcome_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000001','request_completed');
select public.ss_gateway_record_stream_outcome_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000001','request_completed');
select public.final_assert((select slot_held from app_private.gateway_requests));
select public.final_assert((select count(*)=1 from app_private.gateway_stream_outcomes));
select public.final_error($q$select public.life_claim(3,1,'00000000-0000-0000-0000-000000000002')$q$,'FORBIDDEN');
select public.final_error('select public.life_claim(3,2)','STALE_EPOCH');
select public.final_error('select public.life_complete(2)','STALE_EPOCH');
select public.final_error($q$select public.life_complete(1,'00000000-0000-0000-0000-000000000002')$q$,'FORBIDDEN');
-- A provisional/ambiguous response cannot close occupancy.
savepoint ambiguous_completion;
select public.ss_gateway_record_receipt_v1('00000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001',gen_random_uuid(),1,
 jsonb_build_object('scope',(select scope from app_private.gateway_resources where kind='object'),'kind','timeout','outcome','ambiguous',
 'observedBytes',null,'observedAt',clock_timestamp(),'provenance','{}'::jsonb,'verifierRevision','SQL ONLY'));
select public.final_error('select public.life_complete()','OBSERVATION_AMBIGUOUS');
select public.final_assert((select slot_held from app_private.gateway_requests));
rollback to ambiguous_completion;
select public.final_assert(public.life_complete()=public.life_complete());
select public.final_assert((select not slot_held from app_private.gateway_requests));
select public.final_assert((select held_bytes=131080 and slot_held from public.upload_sessions where id='20000000-0000-0000-0000-000000000001'));
select public.final_assert((select reserved_bytes=262160 and active_slots=2 from public.user_usage where owner_id='00000000-0000-0000-0000-000000000001'));
-- Both manifest and temporary operations consume the same account/session slot.
savepoint manifest_writer;
select public.life_claim();
select public.final_error('select public.life_claim(3)','CAPACITY_EXCEEDED');
select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000001',1);
select public.final_error($q$select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000001',1)$q$,'ALREADY_DISPATCHED');
rollback to manifest_writer;
savepoint temporary_writer;
select public.life_claim(3);
select public.final_error($q$select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000013',gen_random_uuid(),1)$q$,'FORBIDDEN');
select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000013','60000000-0000-0000-0000-000000000001',1);
rollback to temporary_writer;
create temp table job as select public.ss_gateway_begin_cleanup_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001') id;
select public.ss_gateway_lease_cleanup_v1('00000000-0000-0000-0000-000000000001',(select id from job));
create function public.life_discover(ep bigint default 2,owner_id uuid default '00000000-0000-0000-0000-000000000001',unexpected boolean default false) returns uuid language sql as $$
 select public.ss_gateway_discover_resource_v1(owner_id,'50000000-0000-0000-0000-000000000001',ep,
 'b0000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000004',
 jsonb_build_object('kind','part','path','discovered-part','scope',(select scope from app_private.gateway_resources where kind='object'),
 'maximumBytes',8,'parent','70000000-0000-0000-0000-000000000003','complete',false,'unexpected',unexpected))
$$;
select public.final_error('select public.life_discover(1)','STALE_EPOCH');
select public.final_error($q$select public.life_discover(2,'00000000-0000-0000-0000-000000000002')$q$,'FORBIDDEN');
savepoint unexpected_resource;
select public.life_discover(unexpected=>true);
select public.final_assert((select count(*)=4 from app_private.gateway_resources));
select public.final_assert((select count(*)=1 from app_private.gateway_invalidations));
select public.final_error($q$select app_private.gateway_check_membership('20000000-0000-0000-0000-000000000001')$q$,'EVIDENCE_QUARANTINED');
rollback to unexpected_resource;
select public.final_assert(public.life_discover()=public.life_discover());
select public.final_error($q$select app_private.gateway_check_membership('20000000-0000-0000-0000-000000000001')$q$,'DISCOVERY_INCOMPLETE');
select public.final_assert((select count(*)=1 from app_private.gateway_discoveries));
select public.final_assert((select count(*)=4 from app_private.gateway_resources));
select public.final_error($q$select public.ss_gateway_settle_cleanup_v1('00000000-0000-0000-0000-000000000001',(select id from job),1,gen_random_uuid(),(select id from certs where kind='membership'))$q$,'MEMBERSHIP_CHANGED');
select public.final_error($q$select public.ss_gateway_reconcile_discoveries_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',2,gen_random_uuid())$q$,'DISCOVERY_INCOMPLETE');
-- Only a test administrator can import a closure. complete=false in a discovery
-- is never itself a completeness assertion, even if replayed.
insert into certs select 'new-membership',null,public.final_cert('membership');
insert into app_private.gateway_discovery_closures values('c0000000-0000-0000-0000-000000000001',
 '20000000-0000-0000-0000-000000000001',2,app_private.gateway_discovery_digest('20000000-0000-0000-0000-000000000001'),
 (select id from certs where kind='new-membership'),'SQL FIXTURE ONLY');
select public.final_assert(public.ss_gateway_reconcile_discoveries_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',2,'c0000000-0000-0000-0000-000000000001')=
 public.ss_gateway_reconcile_discoveries_v1('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',2,'c0000000-0000-0000-0000-000000000001'));
select public.final_error($q$select public.ss_gateway_settle_cleanup_v1('00000000-0000-0000-0000-000000000001',(select id from job),1,gen_random_uuid(),(select id from certs where kind='new-membership'))$q$,'AUTHORITATIVE_ABSENCE_REQUIRED');
select public.final_assert((select count(*)=1 from app_private.gateway_reconciliations));
select public.final_assert(not has_function_privilege('authenticated','public.ss_gateway_complete_stream_v1(uuid,uuid,bigint,uuid,uuid,uuid,uuid)','execute'));
select public.final_assert(not has_table_privilege('ss_gateway_observer','app_private.gateway_discovery_closures','insert'));
rollback;
