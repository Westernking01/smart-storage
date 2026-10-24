-- Serial SQL assertions only. Entire fixture activity rolls back.
begin;
create function public.evidence_assert(ok boolean) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION_FAILED'; end if; end $$;
create function public.evidence_error(statement text,expected text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then if position(expected in sqlerrm)>0 then return; end if; raise; end;
 raise exception 'EXPECTED_ERROR: %',expected;
end $$;
select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',8,'60000000-0000-0000-0000-000000000001');
create function public.test_register(owner_id uuid default '00000000-0000-0000-0000-000000000001',epoch bigint default 1,bytes bigint default 8) returns uuid language sql as $$
 select public.ss_gateway_register_resource_v1(owner_id,'50000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001',epoch,'object',
 'v1/00000000-0000-0000-0000-000000000001/10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/1/0/40000000-0000-0000-0000-000000000001.bin',
 '{"namespace":"local/provider/account/region","uploadId":null,"version":null,"generation":null}',bytes)
$$;
create function public.test_receipt(op uuid,outcome text default 'present',kind text default 'inspection',bytes bigint default 8,owner_id uuid default '00000000-0000-0000-0000-000000000001',epoch bigint default 1) returns uuid language sql as $$
 select public.ss_gateway_record_receipt_v1(owner_id,'70000000-0000-0000-0000-000000000001',op,epoch,
 jsonb_build_object('scope','{"namespace":"local/provider/account/region","uploadId":null,"version":null,"generation":null}'::jsonb,
 'kind',kind,'outcome',outcome,'observedBytes',bytes,'observedAt','2026-01-01T00:00:00Z',
 'provenance',jsonb_build_object('method','HEAD','evidenceDigest',repeat('a',64)),'verifierRevision','local-test-v1'))
$$;
set local role authenticated;
select public.evidence_error('select public.test_register()','permission denied');
select public.evidence_error($q$select public.test_receipt('80000000-0000-0000-0000-000000000001')$q$,'permission denied');
reset role;
set local role ss_gateway_executor;
select public.evidence_error($q$select public.test_register('00000000-0000-0000-0000-000000000002')$q$,'FORBIDDEN');
select public.evidence_error('select public.test_register(epoch=>2)','STALE_EPOCH');
select public.evidence_assert(public.test_register()=public.test_register());
select public.evidence_error('select public.test_register(bytes=>9)','IDEMPOTENCY_CONFLICT');
select public.ss_gateway_register_resource_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000002',1,'manifest','local/10000000-0000-0000-0000-000000000001/manifest',
 '{"namespace":"local/provider/account/region","uploadId":null,"version":null,"generation":null}',131072);
select public.ss_gateway_register_resource_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000003',1,'creation_intent','temporary/intent',
 '{"namespace":"local/provider/account/region","uploadId":null,"version":null,"generation":null}',8,'70000000-0000-0000-0000-000000000001');
select public.ss_gateway_register_resource_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000004',1,'temporary','temporary/provider-id',
 '{"namespace":"local/provider/account/region","uploadId":"upload-1","version":null,"generation":null}',8,'70000000-0000-0000-0000-000000000003');
select public.evidence_error($q$select public.test_receipt('80000000-0000-0000-0000-000000000001')$q$,'permission denied');
reset role;
select public.evidence_assert((select count(*)=4 and max(membership_generation)=4 from app_private.gateway_resources));
select public.evidence_assert((select attempt_id is null from app_private.gateway_resources where kind='manifest'));
select public.evidence_error($q$update app_private.gateway_resources set owner_id='00000000-0000-0000-0000-000000000002'$q$,'EVIDENCE_HISTORY_IMMUTABLE');
set local role ss_gateway_observer;
select public.evidence_error($q$select public.ss_gateway_record_receipt_v1('00000000-0000-0000-0000-000000000001',
 '70000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000009',1,
 '{"scope":{"namespace":"forged"},"kind":"inspection","outcome":"present","observedAt":"2026-01-01","observedBytes":8,"provenance":{},"verifierRevision":"test"}')$q$,'EVIDENCE_MISMATCH');
select public.evidence_assert(public.test_receipt('80000000-0000-0000-0000-000000000001')=public.test_receipt('80000000-0000-0000-0000-000000000001'));
select public.evidence_error($q$select public.test_receipt('80000000-0000-0000-0000-000000000001',bytes=>9)$q$,'IDEMPOTENCY_CONFLICT');
select public.evidence_error($q$select public.test_receipt('80000000-0000-0000-0000-000000000002',owner_id=>'00000000-0000-0000-0000-000000000002')$q$,'FORBIDDEN');
select public.evidence_error($q$select public.test_receipt('80000000-0000-0000-0000-000000000002',epoch=>2)$q$,'STALE_EPOCH');
select public.evidence_error($q$select public.test_receipt('80000000-0000-0000-0000-000000000002','absent','delete_response',null)$q$,'ABSENCE_PROTOCOL_REQUIRED');
select public.test_receipt('80000000-0000-0000-0000-000000000002','ambiguous','timeout',null);
select public.test_receipt('80000000-0000-0000-0000-000000000003','inconclusive','listing',null);
select public.test_receipt('80000000-0000-0000-0000-000000000004','absent','absence',null);
select public.test_receipt('80000000-0000-0000-0000-000000000005',bytes=>9000000);
reset role;
update public.upload_sessions set epoch=2 where id='20000000-0000-0000-0000-000000000001';
set local role ss_gateway_observer;
-- Historical evidence still records after fencing, without current authority.
select public.test_receipt('80000000-0000-0000-0000-000000000006');
select public.test_receipt('80000000-0000-0000-0000-000000000001');
reset role;
select public.evidence_assert((select count(*)=6 and bool_and(sufficiency='provisional') and bool_and(issuer='ss_gateway_observer') from app_private.gateway_observation_receipts));
select public.evidence_assert((select allocation_epoch=1 and decision_epoch=2 from app_private.gateway_observation_receipts where operation_key='80000000-0000-0000-0000-000000000006'));
select public.evidence_assert((select count(*)=1 from app_private.gateway_observation_receipts where outcome='ambiguous'));
select public.evidence_error('delete from app_private.gateway_observation_receipts','EVIDENCE_HISTORY_IMMUTABLE');
select public.evidence_assert((select reserved_bytes=262160 and active_slots=2 and stored_bytes=0 from public.user_usage where owner_id='00000000-0000-0000-0000-000000000001'));
select public.evidence_assert((select slot_held from app_private.gateway_requests where request_id='50000000-0000-0000-0000-000000000001'));
select public.evidence_assert((select held_bytes=131080 and slot_held and state='uploading' from public.upload_sessions where id='20000000-0000-0000-0000-000000000001'));
select public.evidence_assert(not has_table_privilege('ss_gateway_observer','app_private.gateway_observation_receipts','INSERT'));
select public.evidence_assert(not has_function_privilege('service_role','public.ss_gateway_record_receipt_v1(uuid,uuid,uuid,bigint,jsonb)','EXECUTE'));
rollback;
