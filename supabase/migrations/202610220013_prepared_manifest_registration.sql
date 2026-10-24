-- Offline candidate only; no deployment or runtime composition.
begin;
create function public.ss_prepared_manifest_register_v1(
 p_owner uuid,p_executor uuid,p_checkpoint text,p_sha text,p_text text,
 p_session uuid,p_file uuid,p_bindings jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare m jsonb; b jsonb; binding jsonb; q app_private.gateway_requests;
 s public.upload_sessions; f public.files; stored public.file_blocks; i integer; n integer;
begin
 if octet_length(p_text)>131072 or octet_length(p_checkpoint) not between 1 and 1024
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
 -- Common account/session/file lock order, shared with dispatch and lifecycle.
 perform 1 from public.user_usage where owner_id=p_owner for update;
 select * into strict s from public.upload_sessions where id=p_session and owner_id=p_owner for update;
 select * into strict f from public.files where id=p_file and owner_id=p_owner for update;
 if s.file_id<>f.id or f.original_bytes<>(m->>'originalBytes')::bigint
 or f.source_sha256 is distinct from m->>'originalSha256'
 or s.initial_source_sha256 is distinct from m->>'originalSha256'
 or (select count(*) from public.file_blocks where session_id=s.id)<>n
 then raise exception 'IDENTITY_MISMATCH'; end if;
 for i in 0..n-1 loop
  b:=m->'blocks'->i; binding:=p_bindings->i;
  select * into strict stored from public.file_blocks where session_id=s.id and block_index=i and owner_id=p_owner for update;
  if (b->>'index')::integer<>i or (b->>'offset')::bigint<>i*(m->>'blockSize')::bigint
  or (b->>'originalBytes')::bigint<>least((m->>'blockSize')::bigint,f.original_bytes-i*(m->>'blockSize')::bigint)
  or jsonb_build_object('index',stored.block_index,'offset',stored.original_offset,
   'originalBytes',stored.original_bytes,'encodedBytes',stored.encoded_bytes,'codec',stored.codec,
   'originalSha256',stored.original_sha256,'encodedSha256',stored.encoded_sha256) is distinct from b
  or stored.encoded_bytes>(m->>'blockSize')::bigint
  or (stored.codec='raw' and stored.original_sha256<>stored.encoded_sha256)
  then raise exception 'INVALID_BLOCK'; end if;
  select * into strict q from app_private.gateway_requests where request_id=(binding->>'requestId')::uuid and owner_id=p_owner;
  if q.session_id<>s.id or q.file_id<>f.id or q.block_id<>stored.id
  or q.object_path is distinct from 'v1/'||p_owner||'/'||f.id||'/'||s.id||'/'||s.epoch||'/'||i||'/'||q.attempt_id||'.bin'
  then raise exception 'IDENTITY_MISMATCH'; end if;
  insert into app_private.prepared_block_bindings values(p_owner,p_checkpoint,p_sha,i,q.request_id,(binding->>'resourceId')::uuid);
  -- Reuse every durable reservation, expiry, quota, resource and executor check.
  perform public.ss_prepared_block_resolve_v1(p_owner,p_checkpoint,p_sha,i,p_executor);
 end loop;
end $$;
revoke all on function public.ss_prepared_manifest_register_v1(uuid,uuid,text,text,text,uuid,uuid,jsonb)
 from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_prepared_manifest_register_v1(uuid,uuid,text,text,text,uuid,uuid,jsonb) to ss_gateway_executor;
commit;

