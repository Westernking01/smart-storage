begin;
create table app_private.attempt_requests (
  request_id uuid primary key, attempt_id uuid not null references public.transfer_attempts(id),
  body_bytes bigint not null check(body_bytes>0), state text not null default 'reserved' check(state in('reserved','acknowledged','ambiguous')),
  acknowledged_offset bigint, created_at timestamptz not null default now()
);
alter table app_private.attempt_requests enable row level security;
revoke all on app_private.attempt_requests from public,anon,authenticated;
create function public.ss_begin_attempt_request(p_attempt uuid,p_epoch bigint,p_request uuid,p_body bigint) returns void language plpgsql security definer set search_path='' as $$
declare a public.transfer_attempts; s public.upload_sessions; r app_private.attempt_requests; begin
  select * into strict a from public.transfer_attempts where id=p_attempt;
  perform 1 from public.user_usage where owner_id=a.owner_id for update;
  select * into strict s from public.upload_sessions where id=a.session_id for update;
  select * into strict a from public.transfer_attempts where id=p_attempt for update;
  select * into r from app_private.attempt_requests where request_id=p_request;
  if found then raise exception 'REQUEST_REPLAY_REQUIRES_INSPECTION'; end if;
  if s.state<>'uploading' or s.epoch is distinct from p_epoch or a.epoch is distinct from p_epoch or s.lease_expires_at<=now() or a.state not in('authorized','in_flight') or exists(select 1 from app_private.attempt_requests where attempt_id=a.id and state in('reserved','ambiguous')) then raise exception 'ATTEMPT_BLOCKED'; end if;
  if p_body is null or p_body<=0 or p_body>6291456 or a.acknowledged_bytes::numeric+p_body::numeric>a.authorized_max_bytes::numeric or a.attempted_bytes::numeric+p_body::numeric>9223372036854775807 then raise exception 'INVALID_BODY'; end if;
  insert into app_private.attempt_requests(request_id,attempt_id,body_bytes) values(p_request,a.id,p_body);
  update public.transfer_attempts set attempted_bytes=attempted_bytes+p_body,state='in_flight' where id=a.id;
end $$;
create function public.ss_finish_attempt_request(p_request uuid,p_offset bigint) returns void language plpgsql security definer set search_path='' as $$
declare a public.transfer_attempts; r app_private.attempt_requests; begin
  select * into strict r from app_private.attempt_requests where request_id=p_request;
  select * into strict a from public.transfer_attempts where id=r.attempt_id;
  perform 1 from public.user_usage where owner_id=a.owner_id for update;
  perform 1 from public.upload_sessions where id=a.session_id for update;
  select * into strict a from public.transfer_attempts where id=a.id for update;
  select * into strict r from app_private.attempt_requests where request_id=p_request for update;
  if r.state='acknowledged' and r.acknowledged_offset is not distinct from p_offset then return; end if;
  if r.state<>'reserved' then raise exception 'REQUEST_BLOCKED'; end if;
  if p_offset is null then
    update app_private.attempt_requests set state='ambiguous' where request_id=p_request;
    update public.transfer_attempts set state='ambiguous' where id=a.id;
    update public.upload_sessions set state='reconciling',revision=revision+1 where id=a.session_id and state='uploading';
    return;
  end if;
  if p_offset is distinct from a.acknowledged_bytes+r.body_bytes or p_offset>a.authorized_max_bytes then raise exception 'OFFSET_MISMATCH'; end if;
  update app_private.attempt_requests set state='acknowledged',acknowledged_offset=p_offset where request_id=p_request;
  update public.transfer_attempts set acknowledged_bytes=p_offset where id=a.id;
end $$;
create function public.ss_record_observation(p_attempt uuid,p_epoch bigint,p_size bigint) returns void language plpgsql security definer set search_path='' as $$
declare a public.transfer_attempts; s public.upload_sessions; begin
  select * into strict a from public.transfer_attempts where id=p_attempt;
  perform 1 from public.user_usage where owner_id=a.owner_id for update;
  select * into strict s from public.upload_sessions where id=a.session_id for update;
  select * into strict a from public.transfer_attempts where id=a.id for update;
  if s.state='settled' or a.state='settled' then raise exception 'LATE_WRITE_AFTER_SETTLEMENT'; end if;
  if a.epoch is distinct from p_epoch or p_size is null or p_size<>a.authorized_max_bytes then raise exception 'OBJECT_EVIDENCE_MISMATCH'; end if;
  if a.state='present' and a.observed_bytes=p_size then return; end if;
  -- This is provider size/presence evidence, never an original-byte digest claim.
  update public.transfer_attempts set observed_bytes=p_size,provider_verified_at=now(),state=case when s.epoch=a.epoch and s.state='uploading' then 'present' else 'deleting' end where id=a.id;
  update public.file_blocks set state=case when s.epoch=a.epoch and s.state='uploading' then 'present' else 'deleting' end where id=a.block_id;
end $$;
create function public.ss_finalize_verified(p_session uuid,p_manifest jsonb,p_size bigint,p_sha256 text,p_path text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; f public.files; u public.user_usage; count_blocks integer; payload bigint; actual bigint; b public.file_blocks; d jsonb; begin
  select * into strict s from public.upload_sessions where id=p_session;
  select * into strict u from public.user_usage where owner_id=s.owner_id for update;
  select * into strict s from public.upload_sessions where id=p_session for update;
  select * into strict f from public.files where id=s.file_id for update;
  if s.state='completed' then
    if f.manifest_sha256 is distinct from p_sha256 or f.manifest_path is distinct from p_path or f.manifest_bytes is distinct from p_size or not exists(select 1 from public.file_manifests where file_id=f.id and manifest=p_manifest) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return app_private.file_json(f);
  end if;
  if s.state<>'uploading' or s.lease_expires_at<=now() or f.state<>'uploading' then raise exception 'SESSION_EXPIRED_OR_BLOCKED'; end if;
  if jsonb_typeof(p_manifest) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_manifest))<>6 then raise exception 'MANIFEST_INVALID'; end if;
  -- Match the numeric compression-spike envelope; ->> alone also accepts JSON strings.
  if jsonb_typeof(p_manifest->'version') is distinct from 'number' or jsonb_typeof(p_manifest->'blockSize') is distinct from 'number' or jsonb_typeof(p_manifest->'originalBytes') is distinct from 'number' then raise exception 'MANIFEST_INVALID'; end if;
  if p_path is distinct from s.manifest_path or p_size is null or p_size not between 1 and 131072 or p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' or p_manifest is null or octet_length(p_manifest::text)>131072 or p_manifest->>'format' is distinct from 'compression-spike' or p_manifest->>'version' is distinct from '1' or p_manifest->>'blockSize' is distinct from '8388608' or p_manifest->>'originalBytes' is distinct from f.original_bytes::text or p_manifest->>'originalSha256' is distinct from f.source_sha256 or jsonb_typeof(p_manifest->'blocks') is distinct from 'array' then raise exception 'MANIFEST_INVALID'; end if;
  count_blocks:=greatest(1,(f.original_bytes+8388607)/8388608);
  if jsonb_array_length(p_manifest->'blocks')<>count_blocks or (select count(*) from public.file_blocks where file_id=f.id)<>count_blocks then raise exception 'BLOCKS_INCOMPLETE'; end if;
  payload:=0;
  for b in select * from public.file_blocks where file_id=f.id order by block_index for update loop
    d:=p_manifest->'blocks'->b.block_index;
    if b.state<>'present' or b.original_offset<>b.block_index::bigint*8388608 or b.original_bytes<>least(8388608,f.original_bytes-b.original_offset) or
      d is distinct from jsonb_build_object('index',b.block_index,'offset',b.original_offset,'originalBytes',b.original_bytes,'encodedBytes',b.encoded_bytes,'codec',b.codec,'originalSha256',b.original_sha256,'encodedSha256',b.encoded_sha256) or
      not exists(select 1 from public.transfer_attempts where block_id=b.id and epoch<=s.epoch and state='present' and observed_bytes=b.encoded_bytes and provider_verified_at is not null) then raise exception 'BLOCK_EVIDENCE_INVALID'; end if;
    payload:=payload+b.encoded_bytes;
  end loop;
  -- Old or unfinished resources cannot vanish from held accounting during publication.
  if exists(select 1 from public.transfer_attempts where session_id=s.id and state not in('present','settled')) then raise exception 'ATTEMPT_BLOCKED'; end if;
  actual:=payload+p_size;
  if actual>s.held_bytes or u.historical_original_bytes::numeric+f.original_bytes::numeric>9223372036854775807 or u.historical_stored_bytes::numeric+actual::numeric>9223372036854775807 then raise exception 'ACCOUNTING_OVERFLOW_OR_LIMIT'; end if;
  insert into public.file_manifests(file_id,session_id,owner_id,manifest,sha256,object_path,observed_bytes,provider_verified_at) values(f.id,s.id,s.owner_id,p_manifest,p_sha256,p_path,p_size,now());
  update public.files set state='ready',encoded_payload_bytes=payload,manifest_bytes=p_size,stored_bytes=actual,manifest_sha256=p_sha256,manifest_path=p_path,block_count=count_blocks,ready_at=now(),revision=revision+1 where id=f.id returning * into f;
  update public.user_usage set reserved_bytes=reserved_bytes-s.held_bytes,stored_bytes=stored_bytes+actual,active_slots=active_slots-1,historical_original_bytes=historical_original_bytes+f.original_bytes,historical_stored_bytes=historical_stored_bytes+actual,revision=revision+1,updated_at=now() where owner_id=s.owner_id;
  insert into public.usage_events(owner_id,session_id,file_id,event_key,kind,stored_delta,reserved_delta,slot_delta) values(s.owner_id,s.id,f.id,'commit:'||s.id,'commit',actual,-s.held_bytes,-1);
  update public.upload_sessions set state='completed',held_bytes=0,slot_held=false,revision=revision+1,updated_at=now() where id=s.id;
  return app_private.file_json(f);
end $$;
create function public.ss_expire(p_session uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; begin
  select * into strict s from public.upload_sessions where id=p_session;
  perform 1 from public.user_usage where owner_id=s.owner_id for update;
  select * into strict s from public.upload_sessions where id=p_session for update;
  if s.lease_expires_at>now() then raise exception 'NOT_EXPIRED'; end if;
  if s.state in('reserved','uploading','reconciling') then
    update public.upload_sessions set state='expired',epoch=epoch+1,cleanup_after=now(),revision=revision+1 where id=s.id;
    update public.files set state='deleting',deleted_at=now(),revision=revision+1 where id=s.file_id;
    insert into public.cleanup_jobs(owner_id,session_id,file_id,kind) values(s.owner_id,s.id,s.file_id,'cancel') on conflict do nothing;
  end if;
end $$;
create function public.ss_reconcile_removed_attempt(p_attempt uuid,p_writers_fenced boolean,p_removed boolean) returns void language plpgsql security definer set search_path='' as $$
declare a public.transfer_attempts; s public.upload_sessions; begin
  if p_writers_fenced is distinct from true or p_removed is distinct from true then raise exception 'CLEANUP_PROOF_REQUIRED'; end if;
  select * into strict a from public.transfer_attempts where id=p_attempt;
  perform 1 from public.user_usage where owner_id=a.owner_id for update;
  select * into strict s from public.upload_sessions where id=a.session_id for update;
  select * into strict a from public.transfer_attempts where id=a.id for update;
  if s.state not in('reserved','uploading','reconciling') then raise exception 'SESSION_BLOCKED'; end if;
  if a.state='settled' then return; end if;
  update public.transfer_attempts set state='settled' where id=a.id;
  update public.file_blocks set state='allocated' where id=a.block_id;
  update public.upload_sessions set epoch=epoch+1,state='uploading',revision=revision+1 where id=s.id;
  -- Never resets attempted bytes or request history; old reservations stay durable.
end $$;
create function public.ss_settle_cleanup(p_session uuid,p_writers_fenced boolean,p_objects_removed boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; f public.files; stored_release bigint:=0; begin
  if p_writers_fenced is distinct from true or p_objects_removed is distinct from true then raise exception 'CLEANUP_PROOF_REQUIRED'; end if;
  select * into strict s from public.upload_sessions where id=p_session;
  perform 1 from public.user_usage where owner_id=s.owner_id for update;
  select * into strict s from public.upload_sessions where id=p_session for update;
  select * into strict f from public.files where id=s.file_id for update;
  if s.state='settled' then return; end if;
  if f.state<>'deleting' or s.state not in('cancelling','expired','completed') then raise exception 'CLEANUP_STATE_INVALID'; end if;
  if s.state='completed' then stored_release:=f.stored_bytes; end if;
  update public.user_usage set reserved_bytes=reserved_bytes-s.held_bytes,stored_bytes=stored_bytes-stored_release,active_slots=active_slots-case when s.slot_held then 1 else 0 end,revision=revision+1,updated_at=now() where owner_id=s.owner_id;
  insert into public.usage_events(owner_id,session_id,file_id,event_key,kind,stored_delta,reserved_delta,slot_delta) values(s.owner_id,s.id,f.id,'settle:'||s.id,case when stored_release>0 then 'delete' else 'release' end,-stored_release,-s.held_bytes,case when s.slot_held then -1 else 0 end);
  update public.transfer_attempts set state='settled' where session_id=s.id;
  update public.file_blocks set state='deleted' where session_id=s.id;
  update public.files set state='deleted',revision=revision+1 where id=f.id;
  update public.upload_sessions set state='settled',held_bytes=0,slot_held=false,revision=revision+1 where id=s.id;
  update public.cleanup_jobs set state='done' where session_id=s.id;
end $$;
grant usage on schema app_private to authenticated;
revoke all on all functions in schema app_private from public,anon,authenticated;
grant execute on function app_private.actor() to authenticated;
do $$ declare t text; f record; begin
  foreach t in array array['files','user_usage','upload_sessions','file_blocks','transfer_attempts','file_manifests','usage_events'] loop
    execute format('create policy owner_read on public.%I for select to authenticated using (owner_id=(select app_private.actor()))',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
  for f in select oid::regprocedure as sig,proname from pg_proc where pronamespace='public'::regnamespace and proname in
    ('ss_bootstrap','ss_account','ss_list_files','ss_file','ss_edit_file','ss_delete_file','ss_reserve','ss_sessions','ss_allocate_attempt','ss_cancel','ss_begin_attempt_request','ss_finish_attempt_request','ss_record_observation','ss_finalize_verified','ss_expire','ss_reconcile_removed_attempt','ss_settle_cleanup') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    if f.proname in('ss_bootstrap','ss_account','ss_list_files','ss_file','ss_edit_file','ss_delete_file','ss_reserve','ss_sessions','ss_allocate_attempt','ss_cancel') then
      execute format('grant execute on function %s to authenticated',f.sig);
    else
      execute format('grant execute on function %s to service_role',f.sig);
    end if;
  end loop;
end $$;
create policy profile_read on public.profiles for select to authenticated using(id=(select app_private.actor()));
grant select on public.profiles to authenticated;
-- No ordinary UPDATE/INSERT/DELETE grants. No client execution of proof/cleanup RPCs.
commit;
