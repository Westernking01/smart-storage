-- Phase 2.14H.3: atomic trusted block scope resolution and one-use dispatch.
begin;
create function public.ss_gateway_resolve_dispatch_v1(
 p_owner uuid,p_request uuid,p_resource uuid,p_executor uuid,p_epoch bigint,p_generation bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare q app_private.gateway_requests; r app_private.gateway_resources;
 a public.transfer_attempts; b public.file_blocks; s public.upload_sessions;
begin
 select * into q from app_private.gateway_requests where request_id=p_request and owner_id=p_owner;
 if not found or q.executor_id is distinct from p_executor or q.attempt_id is null then raise exception 'FORBIDDEN'; end if;
 a:=app_private.gateway_lock_attempt(p_owner,q.attempt_id);
 select * into strict q from app_private.gateway_requests where request_id=p_request for update;
 select * into strict s from public.upload_sessions where id=q.session_id;
 select * into strict b from public.file_blocks where id=q.block_id;
 -- Include owner in lookup; foreign and nonexistent resources are indistinguishable.
 select * into r from app_private.gateway_resources where resource_id=p_resource and owner_id=p_owner;
 if not found or (r.request_id,r.owner_id,r.session_id,r.file_id,r.attempt_id,r.kind,r.bucket,r.object_path,r.allocation_epoch)
 is distinct from (q.request_id,q.owner_id,q.session_id,q.file_id,q.attempt_id,'object'::text,q.bucket,q.object_path,q.epoch)
 then raise exception 'FORBIDDEN'; end if;
 if p_epoch is distinct from q.epoch or p_epoch is distinct from s.epoch
 or p_generation is distinct from q.dispatch_generation then raise exception 'STALE_FENCE'; end if;
 if not q.slot_held or not s.slot_held or s.state<>'uploading'
 or exists(select 1 from app_private.gateway_invalidations where session_id=s.id)
 then raise exception 'SESSION_BLOCKED'; end if;
 if r.maximum_bytes<q.declared_bytes or r.maximum_bytes>9007199254740991
 or q.epoch>9007199254740991 or q.dispatch_generation>9007199254740991
 or (select coalesce(sum(maximum_bytes::numeric),0) from app_private.gateway_resources where session_id=s.id)>s.held_bytes
 then raise exception 'ACCOUNTING_LIMIT'; end if;
 -- Existing function enforces expiry, active attempt and single-use consumption.
 -- Common locks stay held until caller commit; no transaction spans provider I/O.
 perform public.ss_gateway_dispatch_v1(p_owner,p_request,p_executor,p_epoch);
 return jsonb_build_object('intent',jsonb_build_object(
 'ownerId',q.owner_id,'requestId',q.request_id,'resourceId',r.resource_id,'executorId',q.executor_id,
 'dispatchGeneration',q.dispatch_generation,'epoch',q.epoch,'bucket',q.bucket,'path',q.object_path,
 'sessionId',q.session_id,'fileId',q.file_id,'attemptId',q.attempt_id,'declaredBytes',q.declared_bytes,
 'expectedSha256',b.encoded_sha256,'operation','single-object-create'),
 'decisionId',q.request_id,'writerId',q.executor_id,'reservationId',q.session_id,
 'exposureId',r.resource_id,'maximumEncodedBytes',q.declared_bytes,
 'reservedExposureBytes',r.maximum_bytes,'allowZeroBytes',q.declared_bytes=0);
end $$;
revoke all on function public.ss_gateway_resolve_dispatch_v1(uuid,uuid,uuid,uuid,bigint,bigint)
 from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_gateway_resolve_dispatch_v1(uuid,uuid,uuid,uuid,bigint,bigint) to ss_gateway_executor;
commit;
