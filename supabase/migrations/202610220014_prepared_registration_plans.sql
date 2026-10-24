-- Offline candidate only. No deployment or runtime activation.
begin;
-- Plans are immutable membership, NOT requests, resources, occupied streams or
-- new quota reservations. Dormant attempts must fit the existing session hold.
create table app_private.prepared_block_plans (
 owner_id uuid not null references public.profiles(id),
 checkpoint_id text not null check(octet_length(checkpoint_id) between 1 and 1024),
 manifest_sha256 text not null check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 block_index integer not null check(block_index between 0 and 127),
 attempt_id uuid not null unique references public.transfer_attempts(id),
 request_id uuid not null unique,
 resource_id uuid not null unique,
 executor_id uuid not null,
 bucket text not null,
 epoch bigint not null check(epoch between 1 and 9007199254740991),
 primary key(owner_id,checkpoint_id,block_index)
);
alter table app_private.prepared_block_plans enable row level security;
revoke all on app_private.prepared_block_plans from public,anon,authenticated,service_role,
 ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
create trigger prepared_plan_immutable before update or delete on app_private.prepared_block_plans
 for each row execute function app_private.prepared_binding_immutable();

-- Advisory resolution never claims or dispatches. All checks repeat at dispatch.
create function public.ss_registered_block_resolve_v1(
 p_owner uuid,p_checkpoint text,p_manifest text,p_block integer,p_executor uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare m app_private.prepared_block_plans; a public.transfer_attempts;
 s public.upload_sessions; b public.file_blocks; u public.user_usage;
 c app_private.gateway_accounts; exposure numeric;
begin
 select * into m from app_private.prepared_block_plans where owner_id=p_owner
 and checkpoint_id=p_checkpoint and manifest_sha256=p_manifest and block_index=p_block;
 -- Preserve already-registered legacy authority; no legacy binding is rewritten.
 if not found then return public.ss_prepared_block_resolve_v1(p_owner,p_checkpoint,p_manifest,p_block,p_executor); end if;
 a:=app_private.gateway_lock_attempt(p_owner,m.attempt_id);
 select * into strict s from public.upload_sessions where id=a.session_id and owner_id=p_owner;
 select * into strict b from public.file_blocks where id=a.block_id and owner_id=p_owner;
 select * into strict u from public.user_usage where owner_id=p_owner;
 select * into c from app_private.gateway_accounts where owner_id=p_owner for update;
 if not found or c.bucket is distinct from m.bucket or c.max_active_streams<1
 or (select count(*) from app_private.gateway_requests where owner_id=p_owner and slot_held)>c.max_active_streams
 then raise exception 'CAPACITY_EXCEEDED'; end if;
 if m.executor_id is distinct from p_executor or m.epoch<>s.epoch or a.epoch<>s.epoch
 or b.block_index<>p_block or b.session_id<>s.id or b.file_id<>s.file_id
 or a.authorized_max_bytes<>b.encoded_bytes
 or a.object_path is distinct from 'v1/'||p_owner||'/'||s.file_id||'/'||s.id||'/'||s.epoch||'/'||p_block||'/'||a.id||'.bin'
 then raise exception 'RESERVATION_INVALID'; end if;
 if s.state<>'uploading' or a.state<>'authorized' or a.attempted_bytes<>0 or a.acknowledged_bytes<>0
 or a.observed_bytes is not null or b.state<>'allocated' or not s.slot_held
 or s.lease_expires_at<=clock_timestamp() or a.expires_at<=clock_timestamp()
 or exists(select 1 from app_private.gateway_requests where attempt_id=a.id or request_id=m.request_id)
 or exists(select 1 from app_private.gateway_resources where resource_id=m.resource_id)
 or exists(select 1 from app_private.gateway_invalidations where session_id=s.id)
 or exists(select 1 from app_private.gateway_discoveries where session_id=s.id)
 or not exists(select 1 from public.files where id=s.file_id and state='uploading')
 then raise exception 'SESSION_BLOCKED'; end if;
 select greatest(coalesce((select sum(maximum_bytes::numeric) from app_private.gateway_resources where session_id=s.id),0),
  (select coalesce(sum(authorized_max_bytes::numeric),0)+131072 from public.transfer_attempts where session_id=s.id)
  +coalesce((select sum(maximum_bytes::numeric) from app_private.gateway_resources where session_id=s.id and kind not in ('object','manifest')),0)) into exposure;
 if exposure>s.held_bytes or u.reserved_bytes<s.held_bytes
 or u.stored_bytes::numeric+u.reserved_bytes>u.quota_bytes or u.active_slots<1 or u.active_slots>u.max_slots
 then raise exception 'QUOTA_INSUFFICIENT'; end if;
 return jsonb_build_object('scope',jsonb_build_object('ownerId',p_owner,'checkpointId',p_checkpoint,
 'manifestSha256',p_manifest,'blockIndex',p_block),'intent',jsonb_build_object(
 'ownerId',p_owner,'requestId',m.request_id,'resourceId',m.resource_id,'executorId',m.executor_id,
 'dispatchGeneration',1,'epoch',m.epoch,'bucket',m.bucket,'path',a.object_path,
 'sessionId',s.id,'fileId',s.file_id,'attemptId',a.id,'declaredBytes',b.encoded_bytes,
 'expectedSha256',b.encoded_sha256,'operation','single-object-create'),
 'reservation',jsonb_build_object('ownerId',p_owner,'sessionId',s.id,'state',s.state,
 'expiresAt',floor(extract(epoch from least(s.lease_expires_at,a.expires_at))*1000),
 'reservedBytes',s.held_bytes::text,'requiredExposureBytes',exposure::text));
end $$;

create or replace function public.ss_prepared_manifest_register_v1(
 p_owner uuid,p_executor uuid,p_checkpoint text,p_sha text,p_text text,
 p_session uuid,p_file uuid,p_bindings jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare m jsonb; b jsonb; binding jsonb; a public.transfer_attempts;
 s public.upload_sessions; f public.files; stored public.file_blocks; i integer; n integer;
begin
 if p_text is null or p_checkpoint is null or p_sha is null or p_executor is null
 or octet_length(p_text)>131072 or octet_length(p_checkpoint) not between 1 and 1024
 or p_sha !~ '^[a-f0-9]{64}$'
 or encode(sha256(convert_to(p_text,'UTF8')),'hex') is distinct from p_sha
 then raise exception 'INVALID_MANIFEST'; end if;
 m:=p_text::jsonb;
 if jsonb_typeof(m) is distinct from 'object' or not (m ?& array['format','version','blockSize','originalBytes','originalSha256','blocks'])
 or jsonb_typeof(m->'originalBytes') is distinct from 'number'
 or jsonb_typeof(m->'blockSize') is distinct from 'number'
 or jsonb_typeof(m->'blocks') is distinct from 'array'
 or jsonb_typeof(p_bindings) is distinct from 'array'
 then raise exception 'INVALID_MANIFEST'; end if;
 n:=jsonb_array_length(m->'blocks');
 if m->>'format' is distinct from 'compression-spike' or m->>'version' is distinct from '1'
 or n not between 1 and 128 or jsonb_array_length(p_bindings)<>n
 or (m->>'originalBytes')::bigint not between 0 and 33554432
 or (m->>'blockSize')::integer not between 65536 and 8388608
 or n<>greatest(1,ceil((m->>'originalBytes')::numeric/(m->>'blockSize')::numeric))
 then raise exception 'INVALID_MANIFEST'; end if;
 perform 1 from public.user_usage where owner_id=p_owner for update;
 select * into strict s from public.upload_sessions where id=p_session and owner_id=p_owner for update;
 select * into strict f from public.files where id=p_file and owner_id=p_owner for update;
 if s.file_id<>f.id or f.original_bytes<>(m->>'originalBytes')::bigint
 or f.source_sha256 is distinct from m->>'originalSha256'
 or s.initial_source_sha256 is distinct from m->>'originalSha256'
 or exists(select 1 from public.file_blocks where session_id=s.id and block_index>=n)
 or exists(select 1 from app_private.prepared_block_bindings where owner_id=p_owner and checkpoint_id=p_checkpoint)
 then raise exception 'IDENTITY_MISMATCH'; end if;
 if s.state not in ('reserved','uploading') or not s.slot_held or s.lease_expires_at<=clock_timestamp()
 then raise exception 'SESSION_BLOCKED'; end if;
 if s.state='reserved' then
  update public.upload_sessions set state='uploading',revision=revision+1,updated_at=clock_timestamp()
  where id=s.id returning * into s;
 end if;
 for i in 0..n-1 loop
  b:=m->'blocks'->i; binding:=p_bindings->i;
  if (b->>'index')::integer is distinct from i or (b->>'offset')::bigint is distinct from i*(m->>'blockSize')::bigint
  or (b->>'originalBytes')::bigint is distinct from least((m->>'blockSize')::bigint,f.original_bytes-i*(m->>'blockSize')::bigint)
  then raise exception 'INVALID_BLOCK'; end if;
  select * into stored from public.file_blocks where session_id=s.id and block_index=i and owner_id=p_owner for update;
  if not found then
   -- The legacy allocator intentionally admits only one outstanding attempt.
   -- Trusted whole-manifest preparation instead installs dormant descriptors
   -- atomically, before ANY active claim; existing allocation guards stay intact.
   insert into public.file_blocks(id,file_id,session_id,owner_id,block_index,original_offset,original_bytes,encoded_bytes,codec,original_sha256,encoded_sha256)
   values(gen_random_uuid(),f.id,s.id,p_owner,i,(b->>'offset')::bigint,(b->>'originalBytes')::bigint,
    (b->>'encodedBytes')::bigint,b->>'codec',b->>'originalSha256',b->>'encodedSha256') returning * into stored;
  end if;
  if jsonb_build_object('index',stored.block_index,'offset',stored.original_offset,
   'originalBytes',stored.original_bytes,'encodedBytes',stored.encoded_bytes,'codec',stored.codec,
   'originalSha256',stored.original_sha256,'encodedSha256',stored.encoded_sha256) is distinct from b
  or stored.encoded_bytes>(m->>'blockSize')::bigint
  or (stored.codec='raw' and stored.original_sha256<>stored.encoded_sha256)
  then raise exception 'INVALID_BLOCK'; end if;
  if binding->>'attemptId' is not null then
   select * into strict a from public.transfer_attempts where id=(binding->>'attemptId')::uuid and owner_id=p_owner for update;
  else
   if exists(select 1 from public.transfer_attempts where block_id=stored.id) then raise exception 'ATTEMPT_ALREADY_ALLOCATED'; end if;
   a.id:=gen_random_uuid();
   insert into public.transfer_attempts(id,block_id,session_id,owner_id,epoch,object_path,authorized_max_bytes,expires_at)
   values(a.id,stored.id,s.id,p_owner,s.epoch,'v1/'||p_owner||'/'||f.id||'/'||s.id||'/'||s.epoch||'/'||i||'/'||a.id||'.bin',
    stored.encoded_bytes,s.lease_expires_at) returning * into a;
  end if;
  if a.session_id<>s.id or a.block_id<>stored.id then raise exception 'IDENTITY_MISMATCH'; end if;
  insert into app_private.prepared_block_plans values(p_owner,p_checkpoint,p_sha,i,a.id,
   (binding->>'requestId')::uuid,(binding->>'resourceId')::uuid,p_executor,
   (select bucket from app_private.gateway_accounts where owner_id=p_owner),s.epoch);
  perform public.ss_registered_block_resolve_v1(p_owner,p_checkpoint,p_sha,i,p_executor);
 end loop;
end $$;

create function public.ss_registered_block_dispatch_v1(p_owner uuid,p_executor uuid,p_intent jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m app_private.prepared_block_plans; resolved jsonb;
begin
 select * into m from app_private.prepared_block_plans where owner_id=p_owner and request_id=(p_intent->>'requestId')::uuid;
 if not found then return public.ss_prepared_block_dispatch_v1(p_owner,p_executor,p_intent); end if;
 resolved:=public.ss_registered_block_resolve_v1(p_owner,m.checkpoint_id,m.manifest_sha256,m.block_index,p_executor);
 if resolved->'intent' is distinct from p_intent then raise exception 'IDENTITY_MISMATCH'; end if;
 -- Existing claim serializes account/session and requires conclusive completion
 -- of earlier streams. Partial unique index and all ambiguity fences unchanged.
 perform public.ss_gateway_claim_v1(p_owner,m.attempt_id,m.request_id,(p_intent->>'declaredBytes')::bigint,p_executor);
 perform public.ss_gateway_register_resource_v1(p_owner,m.request_id,m.resource_id,m.epoch,'object',p_intent->>'path',
  jsonb_build_object('namespace','prepared-manifest-v1','uploadId',null,'version',null,'generation',null),(p_intent->>'declaredBytes')::bigint);
 insert into app_private.prepared_block_bindings values(p_owner,m.checkpoint_id,m.manifest_sha256,m.block_index,m.request_id,m.resource_id);
 -- Preserve existing full resource-membership, quota, intent and one-use checks.
 return public.ss_prepared_block_dispatch_v1(p_owner,p_executor,p_intent);
end $$;
revoke all on function public.ss_registered_block_resolve_v1(uuid,text,text,integer,uuid),
 public.ss_registered_block_dispatch_v1(uuid,uuid,jsonb) from public,anon,authenticated,service_role,
 ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_registered_block_resolve_v1(uuid,text,text,integer,uuid),
 public.ss_registered_block_dispatch_v1(uuid,uuid,jsonb) to ss_gateway_executor;
-- CREATE OR REPLACE retains registration's existing owner/ACL and executor-only grant.
commit;
