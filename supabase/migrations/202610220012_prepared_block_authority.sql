-- Offline candidate only. No runtime registration privilege or deployment.
begin;
-- Trusted registration must validate the complete prepared manifest before INSERT.
-- One durable binding per request/resource and checkpoint block; never rebind/retry.
create table app_private.prepared_block_bindings (
 owner_id uuid not null references public.profiles(id),
 checkpoint_id text not null check(octet_length(checkpoint_id) between 1 and 1024),
 manifest_sha256 text not null check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 block_index integer not null check(block_index between 0 and 127),
 request_id uuid not null unique references app_private.gateway_requests(request_id),
 resource_id uuid not null unique references app_private.gateway_resources(resource_id),
 primary key(owner_id,checkpoint_id,block_index)
);
alter table app_private.prepared_block_bindings enable row level security;
revoke all on app_private.prepared_block_bindings from public,anon,authenticated,service_role,
 ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
create function app_private.prepared_binding_immutable() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'PREPARED_BINDING_IMMUTABLE'; end $$;
revoke all on function app_private.prepared_binding_immutable() from public;
create trigger prepared_binding_immutable before update or delete on app_private.prepared_block_bindings
 for each row execute function app_private.prepared_binding_immutable();

create function public.ss_prepared_block_resolve_v1(
 p_owner uuid,p_checkpoint text,p_manifest text,p_block integer,p_executor uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare m app_private.prepared_block_bindings; q app_private.gateway_requests;
 r app_private.gateway_resources; a public.transfer_attempts; s public.upload_sessions;
 b public.file_blocks; u public.user_usage; c app_private.gateway_accounts; exposure numeric;
begin
 select * into m from app_private.prepared_block_bindings where owner_id=p_owner
 and checkpoint_id=p_checkpoint and manifest_sha256=p_manifest and block_index=p_block;
 if not found then raise exception 'RESERVATION_INVALID'; end if;
 select * into strict q from app_private.gateway_requests where request_id=m.request_id and owner_id=p_owner;
 a:=app_private.gateway_lock_attempt(p_owner,q.attempt_id);
 select * into strict q from app_private.gateway_requests where request_id=m.request_id for update;
 select * into strict s from public.upload_sessions where id=q.session_id and owner_id=p_owner;
 select * into strict b from public.file_blocks where id=q.block_id and owner_id=p_owner;
 select * into strict r from app_private.gateway_resources where resource_id=m.resource_id and owner_id=p_owner;
 select * into strict u from public.user_usage where owner_id=p_owner;
 select * into c from app_private.gateway_accounts where owner_id=p_owner for update;
 if not found or c.bucket is distinct from q.bucket
 or (select count(*) from app_private.gateway_requests where owner_id=p_owner and slot_held)>c.max_active_streams
 then raise exception 'CAPACITY_EXCEEDED'; end if;
 if q.executor_id is distinct from p_executor or q.dispatched_at is not null
 or (r.request_id,r.session_id,r.file_id,r.attempt_id,r.bucket,r.object_path,r.allocation_epoch,r.kind)
 is distinct from (q.request_id,q.session_id,q.file_id,q.attempt_id,q.bucket,q.object_path,q.epoch,'object'::text)
 or b.block_index<>p_block or b.session_id<>s.id or b.file_id<>q.file_id
 or a.block_id<>b.id or a.object_path<>q.object_path or q.epoch<>s.epoch or a.epoch<>s.epoch
 or q.declared_bytes<>b.encoded_bytes or q.declared_bytes<>a.authorized_max_bytes
 or r.maximum_bytes<q.declared_bytes or q.epoch>9007199254740991
 or q.dispatch_generation>9007199254740991 then raise exception 'RESERVATION_INVALID'; end if;
 if s.state<>'uploading' or a.state<>'in_flight' or b.state<>'allocated'
 or not s.slot_held or not q.slot_held or s.lease_expires_at<=clock_timestamp()
 or a.expires_at<=clock_timestamp()
 or exists(select 1 from app_private.gateway_invalidations where session_id=s.id)
 or not exists(select 1 from public.files where id=s.file_id and state='uploading')
 then raise exception 'SESSION_BLOCKED'; end if;
 -- Include all registered exposure AND the existing conservative manifest/attempt allowance.
 select greatest(coalesce((select sum(maximum_bytes::numeric) from app_private.gateway_resources where session_id=s.id),0),
  (select coalesce(sum(authorized_max_bytes::numeric),0)+131072 from public.transfer_attempts where session_id=s.id)) into exposure;
 if exposure>s.held_bytes or u.reserved_bytes<s.held_bytes
 or u.stored_bytes::numeric+u.reserved_bytes>u.quota_bytes or u.active_slots<1
 or u.active_slots>u.max_slots then raise exception 'QUOTA_INSUFFICIENT'; end if;
 return jsonb_build_object('scope',jsonb_build_object('ownerId',p_owner,'checkpointId',p_checkpoint,
 'manifestSha256',p_manifest,'blockIndex',p_block), 'intent',jsonb_build_object(
 'ownerId',p_owner,'requestId',q.request_id,'resourceId',r.resource_id,'executorId',q.executor_id,
 'dispatchGeneration',q.dispatch_generation,'epoch',q.epoch,'bucket',q.bucket,'path',q.object_path,
 'sessionId',q.session_id,'fileId',q.file_id,'attemptId',q.attempt_id,'declaredBytes',q.declared_bytes,
 'expectedSha256',b.encoded_sha256,'operation','single-object-create'),
 'reservation',jsonb_build_object('ownerId',p_owner,'sessionId',s.id,'state',s.state,
 'expiresAt',floor(extract(epoch from least(s.lease_expires_at,a.expires_at))*1000),
 'reservedBytes',s.held_bytes::text,'requiredExposureBytes',exposure::text));
end $$;

create function public.ss_prepared_block_dispatch_v1(p_owner uuid,p_executor uuid,p_intent jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m app_private.prepared_block_bindings; resolved jsonb;
begin
 select * into strict m from app_private.prepared_block_bindings
 where owner_id=p_owner and request_id=(p_intent->>'requestId')::uuid;
 resolved:=public.ss_prepared_block_resolve_v1(p_owner,m.checkpoint_id,m.manifest_sha256,m.block_index,p_executor);
 if resolved->'intent' is distinct from p_intent then raise exception 'IDENTITY_MISMATCH'; end if;
 -- Same transaction and common account/session locks: expiry/fences/one-use rechecked.
 return public.ss_gateway_resolve_dispatch_v1(p_owner,m.request_id,m.resource_id,p_executor,
 (p_intent->>'epoch')::bigint,(p_intent->>'dispatchGeneration')::bigint);
end $$;
revoke all on function public.ss_prepared_block_resolve_v1(uuid,text,text,integer,uuid),
 public.ss_prepared_block_dispatch_v1(uuid,uuid,jsonb) from public,anon,authenticated,service_role,
 ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_prepared_block_resolve_v1(uuid,text,text,integer,uuid),
 public.ss_prepared_block_dispatch_v1(uuid,uuid,jsonb) to ss_gateway_executor;
commit;
