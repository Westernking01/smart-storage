-- Assertions roll back, leaving fixture accounts available for connection races.
begin;
create function public.gateway_test_assert(ok boolean) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION_FAILED'; end if; end $$;
create function public.gateway_test_error(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'EXPECTED_ERROR: %',expected;
end $$;
-- No public/client/service-role privilege; only the dedicated role may execute.
select public.gateway_test_assert(not has_function_privilege('anon','public.ss_gateway_claim_v1(uuid,uuid,uuid,bigint,uuid)','EXECUTE'));
select public.gateway_test_assert(not has_function_privilege('authenticated','public.ss_gateway_claim_v1(uuid,uuid,uuid,bigint,uuid)','EXECUTE'));
select public.gateway_test_assert(not has_function_privilege('service_role','public.ss_gateway_dispatch_v1(uuid,uuid,uuid,bigint)','EXECUTE'));
set local role authenticated;
select public.gateway_test_error($q$select public.ss_gateway_claim_v1(null,null,null,8,null)$q$,'permission denied');
reset role;
set local role ss_gateway_executor;
select public.gateway_test_error($q$select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',8,'60000000-0000-0000-0000-000000000001')$q$,'FORBIDDEN');
select public.gateway_test_error($q$select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',7,'60000000-0000-0000-0000-000000000001')$q$,'INVALID_LENGTH');
select public.gateway_test_assert(public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',8,'60000000-0000-0000-0000-000000000001')->>'kind'='claimed');
select public.gateway_test_assert(public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',8,'60000000-0000-0000-0000-000000000001')->>'kind'='ambiguous');
select public.gateway_test_error($q$select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',7,'60000000-0000-0000-0000-000000000001')$q$,'IDEMPOTENCY_CONFLICT');
select public.gateway_test_error($q$select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002',8,'60000000-0000-0000-0000-000000000001')$q$,'CAPACITY_EXCEEDED');
select public.gateway_test_error($q$select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',1)$q$,'FORBIDDEN');
reset role;
savepoint expiry_test;
update public.upload_sessions set lease_expires_at=clock_timestamp()-interval '1 second' where id='20000000-0000-0000-0000-000000000001';
set local role ss_gateway_executor;
select public.gateway_test_error($q$select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',1)$q$,'EXPIRED');
rollback to expiry_test;
set local role ss_gateway_executor;
select public.gateway_test_assert(public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',1)->>'kind'='dispatch_granted');
select public.gateway_test_error($q$select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',1)$q$,'ALREADY_DISPATCHED');
reset role;
select public.gateway_test_assert((select count(*)=1 from app_private.gateway_requests));
select public.gateway_test_assert((select attempted_bytes=8 from public.transfer_attempts where id='40000000-0000-0000-0000-000000000001'));
select public.gateway_test_assert((select reserved_bytes=262160 and active_slots=2 from public.user_usage where owner_id='00000000-0000-0000-0000-000000000001'));
select public.gateway_test_error($q$update public.transfer_attempts set attempt_number=2 where id='40000000-0000-0000-0000-000000000001'$q$,'ATTEMPT_HISTORY_IMMUTABLE');
select public.gateway_test_error($q$update public.file_blocks set encoded_sha256=repeat('b',64) where id='30000000-0000-0000-0000-000000000001'$q$,'BLOCK_IDENTITY_IMMUTABLE');
select public.gateway_test_error($q$update public.upload_sessions set manifest_path='changed' where id='20000000-0000-0000-0000-000000000001'$q$,'SESSION_IDENTITY_IMMUTABLE');
select public.gateway_test_error($q$update app_private.gateway_requests set slot_held=false$q$,'GATEWAY_HISTORY_IMMUTABLE');
select public.gateway_test_error($q$select public.ss_begin_attempt_request('40000000-0000-0000-0000-000000000001',1,'50000000-0000-0000-0000-000000000009',1)$q$,'GATEWAY_V1_REQUIRED');
select public.gateway_test_error($q$select public.ss_reconcile_removed_attempt('40000000-0000-0000-0000-000000000001',true,true)$q$,'EVIDENCE_REQUIRED');
update public.upload_sessions set epoch=2,lease_expires_at=clock_timestamp()-interval '1 second' where id='20000000-0000-0000-0000-000000000001';
select public.gateway_test_error($q$update public.upload_sessions set epoch=1 where id='20000000-0000-0000-0000-000000000001'$q$,'STALE_EPOCH');
set local role ss_gateway_executor;
select public.gateway_test_error($q$select public.ss_gateway_dispatch_v1('00000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',1)$q$,'STALE_EPOCH');
-- Expired first claim still occupies the account slot in another live session.
select public.gateway_test_error($q$select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002',8,'60000000-0000-0000-0000-000000000001')$q$,'CAPACITY_EXCEEDED');
reset role;
select public.ss_expire('20000000-0000-0000-0000-000000000001');
select public.gateway_test_error($q$select public.ss_settle_cleanup('20000000-0000-0000-0000-000000000001',true,true)$q$,'EVIDENCE_REQUIRED');
select public.gateway_test_assert((select count(*)=1 from app_private.gateway_requests where slot_held));
rollback;
-- Zero-byte raw claims still consume a stream, despite a zero attempted count.
begin;
-- Source identity is immutable, so construct separate valid fixtures instead of
-- weakening those guards to manufacture boundary sizes.
insert into auth.users(id) values('00000000-0000-0000-0000-000000000005');
insert into public.profiles(id) values('00000000-0000-0000-0000-000000000005');
insert into public.user_usage(owner_id,quota_bytes,reserved_bytes,active_slots,max_slots)
 values('00000000-0000-0000-0000-000000000005',131072,131072,1,1);
insert into app_private.gateway_accounts(owner_id,max_active_streams,bucket)
 values('00000000-0000-0000-0000-000000000005',1,'local-gateway-test');
insert into public.files(id,owner_id,original_name,display_name,original_bytes,source_sha256)
 values('10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000005','empty','empty',0,repeat('a',64));
insert into public.upload_sessions(id,file_id,owner_id,idempotency_key,request_digest,state,held_bytes,lease_expires_at,initial_source_sha256,manifest_path)
 values('20000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000005','empty-test-key-0001','empty','uploading',131072,clock_timestamp()+interval '1 day',repeat('a',64),'local/empty/manifest');
insert into public.file_blocks(id,file_id,session_id,owner_id,block_index,original_offset,original_bytes,encoded_bytes,codec,original_sha256,encoded_sha256)
 values('30000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000005',0,0,0,0,'raw',repeat('a',64),repeat('a',64));
insert into public.transfer_attempts(id,block_id,session_id,owner_id,epoch,object_path,authorized_max_bytes,expires_at)
 values('40000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000005',1,'local/empty/block',0,clock_timestamp()+interval '1 day');
select public.ss_gateway_claim_v1('00000000-0000-0000-0000-000000000005','40000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000005',0,'60000000-0000-0000-0000-000000000001');
do $$ begin
 if (select count(*) from app_private.gateway_requests where declared_bytes=0 and slot_held)<>1 then raise exception 'ZERO_BYTE_SLOT_MISSING'; end if;
end $$;
rollback;
-- A rollback must remove both request occupancy and attempted-byte increments.
begin;
do $$ begin
 if exists(select 1 from app_private.gateway_requests) or exists(select 1 from public.transfer_attempts where attempted_bytes<>0) then raise exception 'ROLLBACK_LEAK'; end if;
end $$;
rollback;
