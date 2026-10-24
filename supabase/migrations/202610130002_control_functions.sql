begin;
create function app_private.actor() returns uuid language plpgsql stable set search_path='' as $$
declare a uuid := auth.uid(); begin
  if a is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or auth.jwt()->>'role' is distinct from 'authenticated' then raise exception 'UNAUTHENTICATED'; end if;
  return a;
end $$;
create function app_private.valid_name(v text) returns boolean language sql immutable set search_path='' as $$
  select v is not null and octet_length(v) between 1 and 255 and btrim(v)<>'' and v not in('.','..') and v !~ '[[:cntrl:]/\\]' and v !~ '[‪-‮⁦-⁩]'
$$;
create function public.ss_bootstrap() returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid := app_private.actor(); p app_private.account_policy; begin
  select * into strict p from app_private.account_policy where singleton;
  insert into public.profiles(id) values(a) on conflict do nothing;
  insert into public.user_usage(owner_id,quota_bytes,max_slots) values(a,p.quota_bytes,p.max_slots) on conflict do nothing;
  return jsonb_build_object('id',a);
end $$;
create function public.ss_account() returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid := app_private.actor(); u public.user_usage; begin
  select * into u from public.user_usage where owner_id=a;
  if not found then return jsonb_build_object('id',a,'needsBootstrap',true); end if;
  return jsonb_build_object('id',a,'needsBootstrap',false,'usage',jsonb_build_object('quotaBytes',u.quota_bytes::text,'storedBytes',u.stored_bytes::text,'reservedBytes',u.reserved_bytes::text,'activeSlots',u.active_slots,'maxSlots',u.max_slots,'historicalOriginalBytes',u.historical_original_bytes::text,'historicalStoredBytes',u.historical_stored_bytes::text));
end $$;
create function app_private.file_json(f public.files) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',f.id,'displayName',f.display_name,'originalName',f.original_name,'originalMime',f.original_mime,'category',f.category,'state',f.state,'originalBytes',f.original_bytes::text,'encodedBytes',f.encoded_payload_bytes::text,'manifestBytes',f.manifest_bytes::text,'storedBytes',f.stored_bytes::text,'createdAt',f.created_at,'revision',f.revision)
$$;
create function public.ss_list_files(p_limit integer default 25,p_before timestamptz default null,p_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid := app_private.actor(); result jsonb; begin
  if p_limit is null or p_limit not between 1 and 50 or (p_before is null)<>(p_id is null) then raise exception 'INVALID_INPUT'; end if;
  select coalesce(jsonb_agg(app_private.file_json(f) order by f.created_at desc,f.id desc),'[]'::jsonb) into result from
    (select * from public.files where owner_id=a and state='ready' and (p_before is null or (created_at,id)<(p_before,p_id)) order by created_at desc,id desc limit p_limit) f;
  return result;
end $$;
create function public.ss_file(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid := app_private.actor(); f public.files; begin
  select * into f from public.files where id=p_id and owner_id=a and state='ready';
  if not found then raise exception 'NOT_FOUND'; end if;
  return app_private.file_json(f);
end $$;
create function public.ss_edit_file(p_id uuid,p_name text,p_category text,p_revision bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid := app_private.actor(); f public.files; begin
  if not app_private.valid_name(p_name) or p_category is null or p_category not in('document','image','video','audio','archive','other') then raise exception 'INVALID_INPUT'; end if;
  select * into f from public.files where id=p_id and owner_id=a for update;
  if not found or f.state<>'ready' then raise exception 'NOT_FOUND'; end if;
  if f.revision is distinct from p_revision then raise exception 'REVISION_CONFLICT'; end if;
  update public.files set display_name=p_name,category=p_category,revision=revision+1 where id=f.id returning * into f;
  return app_private.file_json(f);
end $$;
create function public.ss_delete_file(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid := app_private.actor(); f public.files; s public.upload_sessions; begin
  perform 1 from public.user_usage where owner_id=a for update;
  select * into s from public.upload_sessions where file_id=p_id and owner_id=a for update;
  select * into f from public.files where id=p_id and owner_id=a for update;
  if not found or f.state not in('ready','deleting','deleted') then raise exception 'NOT_FOUND'; end if;
  if f.state='ready' then
    update public.files set state='deleting',deleted_at=now(),revision=revision+1 where id=f.id;
    insert into public.cleanup_jobs(owner_id,session_id,file_id,kind) values(a,s.id,f.id,'delete') on conflict do nothing;
  end if;
  return jsonb_build_object('state',case when f.state='deleted' then 'deleted' else 'deleting' end);
end $$;
create function public.ss_reserve(p_key text,p_name text,p_mime text,p_original bigint,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid := app_private.actor(); u public.user_usage; s public.upload_sessions; fid uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); required bigint; fingerprint text; begin
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,80}$' or not app_private.valid_name(p_name) or p_original is null or p_original not between 0 and 33554432 or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or (p_mime is not null and (octet_length(p_mime)>127 or p_mime !~ '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$')) then raise exception 'INVALID_INPUT'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_name,p_mime,p_original,p_hash)::text,'UTF8')),'hex');
  select * into u from public.user_usage where owner_id=a for update;
  if not found then raise exception 'ACCOUNT_SETUP_REQUIRED'; end if;
  select * into s from public.upload_sessions where owner_id=a and idempotency_key=p_key;
  if found then
    if s.request_digest<>fingerprint then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('id',s.id,'fileId',s.file_id,'state',s.state,'heldBytes',s.held_bytes::text,'epoch',s.epoch);
  end if;
  required:=p_original+131072;
  if u.stored_bytes::numeric+u.reserved_bytes::numeric+required::numeric>u.quota_bytes::numeric then raise exception 'QUOTA_EXCEEDED'; end if;
  if u.active_slots>=u.max_slots then raise exception 'SLOTS_EXCEEDED'; end if;
  insert into public.files(id,owner_id,original_name,display_name,original_mime,original_bytes,source_sha256) values(fid,a,p_name,p_name,p_mime,p_original,p_hash);
  insert into public.upload_sessions(id,file_id,owner_id,idempotency_key,request_digest,held_bytes,lease_expires_at,initial_source_sha256,manifest_path)
    values(sid,fid,a,p_key,fingerprint,required,now()+interval '24 hours',p_hash,'v1/'||a||'/'||fid||'/'||sid||'/1/manifest/'||gen_random_uuid()||'.bin');
  update public.user_usage set reserved_bytes=reserved_bytes+required,active_slots=active_slots+1,revision=revision+1,updated_at=now() where owner_id=a;
  insert into public.usage_events(owner_id,session_id,file_id,event_key,kind,reserved_delta,slot_delta) values(a,sid,fid,'reserve:'||sid,'reserve',required,1);
  return jsonb_build_object('id',sid,'fileId',fid,'state','reserved','heldBytes',required::text,'epoch',1);
end $$;
create function public.ss_sessions() returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid:=app_private.actor(); result jsonb; begin
  select coalesce(jsonb_agg(v),'[]'::jsonb) into result from
    (select jsonb_build_object('id',id,'fileId',file_id,'state',state,'heldBytes',held_bytes::text,'epoch',epoch,'expiresAt',lease_expires_at) v from public.upload_sessions where owner_id=a order by created_at desc,id desc limit 50) q;
  return result;
end $$;
create function public.ss_allocate_attempt(p_session uuid,p_index integer,p_original bigint,p_encoded bigint,p_codec text,p_original_hash text,p_encoded_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid:=app_private.actor(); s public.upload_sessions; f public.files; b public.file_blocks; attempt uuid:=gen_random_uuid(); number integer; path text; begin
  perform 1 from public.user_usage where owner_id=a for update;
  select * into s from public.upload_sessions where id=p_session and owner_id=a for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if s.state='reconciling' then raise exception 'AMBIGUOUS_ATTEMPT_LOCKED'; end if;
  if s.state not in('reserved','uploading') or s.lease_expires_at<=now() then raise exception 'SESSION_EXPIRED_OR_BLOCKED'; end if;
  select * into strict f from public.files where id=s.file_id and owner_id=a for update;
  if p_index is null or p_index<0 or p_index>=greatest(1,(f.original_bytes+8388607)/8388608) or p_original is distinct from least(8388608,f.original_bytes-p_index::bigint*8388608) then raise exception 'INVALID_BLOCK'; end if;
  if exists(select 1 from public.transfer_attempts where session_id=s.id and state in('authorized','in_flight','ambiguous')) then raise exception 'AMBIGUOUS_ATTEMPT_LOCKED'; end if;
  select * into b from public.file_blocks where file_id=f.id and block_index=p_index for update;
  if not found then
    insert into public.file_blocks(file_id,session_id,owner_id,block_index,original_offset,original_bytes,encoded_bytes,codec,original_sha256,encoded_sha256)
    values(f.id,s.id,a,p_index,p_index::bigint*8388608,p_original,p_encoded,p_codec,p_original_hash,p_encoded_hash) returning * into b;
  elsif b.encoded_bytes is distinct from p_encoded or b.codec is distinct from p_codec or b.original_sha256 is distinct from p_original_hash or b.encoded_sha256 is distinct from p_encoded_hash then raise exception 'BLOCK_IMMUTABLE';
  end if;
  if exists(select 1 from public.transfer_attempts where block_id=b.id and state<>'settled') then raise exception 'AMBIGUOUS_ATTEMPT_LOCKED'; end if;
  select coalesce(max(attempt_number),0)+1 into number from public.transfer_attempts where block_id=b.id;
  if number>2 then raise exception 'ATTEMPT_LIMIT'; end if;
  path:='v1/'||a||'/'||f.id||'/'||s.id||'/'||s.epoch||'/'||p_index||'/'||attempt||'.bin';
  insert into public.transfer_attempts(id,block_id,session_id,owner_id,attempt_number,epoch,object_path,authorized_max_bytes,expires_at) values(attempt,b.id,s.id,a,number,s.epoch,path,p_encoded,s.lease_expires_at);
  update public.upload_sessions set state='uploading',revision=revision+1,updated_at=now() where id=s.id;
  return jsonb_build_object('id',attempt,'path',path,'epoch',s.epoch,'authorizedBytes',p_encoded::text,'storageAuthorityEnabled',false);
end $$;
create function public.ss_cancel(p_session uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid:=app_private.actor(); s public.upload_sessions; begin
  perform 1 from public.user_usage where owner_id=a for update;
  select * into s from public.upload_sessions where id=p_session and owner_id=a for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if s.state='completed' then raise exception 'ALREADY_COMPLETED_USE_DELETE'; end if;
  if s.state not in('cancelling','expired','settled') then
    update public.upload_sessions set state='cancelling',epoch=epoch+1,cleanup_after=now(),revision=revision+1,updated_at=now() where id=s.id;
    update public.files set state='deleting',revision=revision+1,deleted_at=now() where id=s.file_id;
    insert into public.cleanup_jobs(owner_id,session_id,file_id,kind) values(a,s.id,s.file_id,'cancel') on conflict do nothing;
  end if;
  return jsonb_build_object('state',case when s.state='settled' then 'settled' else 'cancelling' end,'capacityReleased',false);
end $$;
-- Deny default PUBLIC execution while the following migration installs explicit grants.
do $$ declare f record; begin
  for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('ss_bootstrap','ss_account','ss_list_files','ss_file','ss_edit_file','ss_delete_file','ss_reserve','ss_sessions','ss_allocate_attempt','ss_cancel') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
  end loop;
end $$;
commit;
