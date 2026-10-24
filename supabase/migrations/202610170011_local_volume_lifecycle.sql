-- LOCAL ONLY. No login, account policy, volume or remote resource is provisioned.
begin;
create role ss_volume_gateway nologin noinherit;
create table app_private.volume_sessions (
 session_id uuid primary key references public.upload_sessions,
 owner_id uuid not null, manifest jsonb not null,
 manifest_text text not null check(octet_length(manifest_text) between 1 and 131072),
 manifest_sha256 text not null, volume_id uuid not null,
 foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id)
);
create table app_private.volume_objects (
 id uuid primary key default gen_random_uuid(), session_id uuid not null references app_private.volume_sessions,
 block_index integer not null, unique(session_id,block_index),
 encoded_bytes bigint not null check(encoded_bytes between 0 and 8388608),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 state text not null default 'pending' check(state in('pending','writing','complete','removed')),
 executor_id uuid, receipt_id uuid unique, removal_id uuid unique,
 check((state='pending' and executor_id is null) or (state<>'pending')),
 check(state<>'complete' or receipt_id is not null)
);
create table app_private.volume_settlements (
 session_id uuid primary key references app_private.volume_sessions,
 owner_id uuid not null, kind text not null check(kind in('commit','release')),
 released_bytes bigint not null, stored_bytes bigint not null,
 created_at timestamptz not null default clock_timestamp()
);
create table app_private.volume_deletions (
 session_id uuid primary key references app_private.volume_sessions,
 owner_id uuid not null, stored_bytes bigint not null,
 created_at timestamptz not null default clock_timestamp()
);
create table app_private.volume_readers (
 reader_id uuid primary key, session_id uuid not null references app_private.volume_sessions,
 object_id uuid not null references app_private.volume_objects,
 closed boolean not null default false
);
create trigger immutable before update or delete on app_private.volume_deletions
 for each row execute function app_private.gateway_evidence_immutable();
create function app_private.volume_object_transition() returns trigger
language plpgsql set search_path='' as $$ begin
 if tg_op='DELETE' then raise exception 'VOLUME_HISTORY_IMMUTABLE'; end if;
 if (old.id,old.session_id,old.block_index,old.encoded_bytes,old.sha256) is distinct from
 (new.id,new.session_id,new.block_index,new.encoded_bytes,new.sha256)
 or (old.executor_id is not null and new.executor_id is distinct from old.executor_id)
 or (old.receipt_id is not null and new.receipt_id is distinct from old.receipt_id)
 or (old.removal_id is not null and new.removal_id is distinct from old.removal_id)
 or (old.state<>new.state and not ((old.state='pending' and new.state in('writing','removed'))
  or (old.state='writing' and new.state in('complete','removed')) or (old.state='complete' and new.state='removed')))
 or (new.state='writing' and new.executor_id is null)
 or (new.state='removed' and new.removal_id is null)
 then raise exception 'VOLUME_HISTORY_IMMUTABLE'; end if;
 return new;
end $$;
create trigger volume_object_transition before update or delete on app_private.volume_objects
 for each row execute function app_private.volume_object_transition();
create trigger immutable before update or delete on app_private.volume_sessions
 for each row execute function app_private.gateway_evidence_immutable();
create trigger immutable before update or delete on app_private.volume_settlements
 for each row execute function app_private.gateway_evidence_immutable();

-- No generic attempt may introduce a second data plane for a volume session.
create function app_private.volume_no_alternate_writer() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if exists(select 1 from app_private.volume_sessions where session_id=new.session_id)
 then raise exception 'VOLUME_GATEWAY_REQUIRED'; end if;
 return new;
end $$;
create trigger volume_no_alternate_writer before insert on public.file_blocks
 for each row execute function app_private.volume_no_alternate_writer();

-- Retain all generic evidence guards; recognize only an exact, private local
-- settlement for this new data plane. No caller-set GUC/boolean bypass exists.
do $$ declare d text; needle text; replacement text; begin
 d:=pg_get_functiondef('app_private.gateway_identity_guard()'::regprocedure);
 needle:='if new.state<>''settled'' or new.held_bytes<>0 or new.slot_held or not exists(';
 replacement:='if not exists(select 1 from app_private.volume_settlements v where v.session_id=old.id and v.owner_id=old.owner_id and v.released_bytes=old.held_bytes and new.held_bytes=0 and not new.slot_held and ((v.kind=''commit'' and new.state=''completed'') or (v.kind=''release'' and new.state=''settled''))) and (new.state<>''settled'' or new.held_bytes<>0 or new.slot_held or not exists(';
 if position(needle in d)=0 then raise exception 'GUARD_DEFINITION_CHANGED'; end if;
 d:=replace(d,needle,replacement);
 d:=replace(d,'and released_bytes=old.held_bytes and released_slots=1) then',
 'and released_bytes=old.held_bytes and released_slots=1)) then');
 execute d;
end $$;

-- One restricted server entry point. p_owner comes ONLY from fresh verified
-- Supabase getUser, never from request JSON. The role has no table privileges.
create function public.ss_volume_command(p_owner uuid,p_action text,p_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; v app_private.volume_sessions; o app_private.volume_objects;
 m jsonb; b jsonb; r jsonb; idx integer:=0; total bigint:=0; original bigint; bs bigint;
 txt text; encoded bigint; manifest_size bigint; stored bigint; result jsonb;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'READ_COMMITTED_REQUIRED'; end if;
 if p_owner is null then raise exception 'UNAUTHENTICATED'; end if;
 perform 1 from public.user_usage where owner_id=p_owner for update;
 if not found then raise exception 'ACCOUNT_SETUP_REQUIRED'; end if;
 if p_action='begin' then
  m:=p_data->'manifest'; txt:=p_data->>'manifestText';
  if txt is null or octet_length(txt)>131072 or octet_length(m::text)>131072 or txt::jsonb is distinct from m
   or m->>'format' is distinct from 'compression-spike' or m->'version' is distinct from '1'::jsonb
   or jsonb_typeof(m->'originalBytes') is distinct from 'number'
   or jsonb_typeof(m->'blockSize') is distinct from 'number'
   or jsonb_typeof(m->'blocks') is distinct from 'array'
   or coalesce(m->>'originalSha256','') !~ '^[a-f0-9]{64}$'
  then raise exception 'INVALID_INPUT'; end if;
  original:=(m->>'originalBytes')::bigint; bs:=(m->>'blockSize')::bigint;
  if original not between 0 and 33554432 or bs not between 65536 and 8388608
   or jsonb_array_length(m->'blocks')<>greatest(1,(original+bs-1)/bs)
   or jsonb_array_length(m->'blocks')>128 then raise exception 'INVALID_INPUT'; end if;
  for b in select value from jsonb_array_elements(m->'blocks') loop
   encoded:=(b->>'encodedBytes')::bigint;
   if (b->>'index')::integer is distinct from idx or (b->>'offset')::bigint is distinct from idx*bs
    or (b->>'originalBytes')::bigint is distinct from least(bs,original-idx*bs)
    or encoded is null or encoded<0 or encoded>least(bs,original-idx*bs)
    or coalesce(b->>'encodedSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(b->>'originalSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(b->>'codec','') not in('raw','gzip')
    or (b->>'codec'='raw' and encoded<>least(bs,original-idx*bs))
    or (b->>'codec'='gzip' and (encoded<18 or least(bs,original-idx*bs)=0))
   then raise exception 'INVALID_INPUT'; end if;
   total:=total+encoded; idx:=idx+1;
  end loop;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p_owner,'role','authenticated')::text,true);
  r:=public.ss_reserve(p_data->>'key',p_data->>'name',p_data->>'mime',original,m->>'originalSha256');
  p_id:=(r->>'id')::uuid;
  select * into v from app_private.volume_sessions where session_id=p_id;
  if found then
   if v.manifest_text<>txt or v.volume_id is distinct from (p_data->>'volumeId')::uuid then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  else
   if exists(select 1 from public.file_blocks where session_id=p_id) or r->>'state'<>'reserved'
   then raise exception 'SESSION_BLOCKED'; end if;
   insert into app_private.volume_sessions values(p_id,p_owner,m,txt,
    encode(sha256(convert_to(txt,'UTF8')),'hex'),(p_data->>'volumeId')::uuid);
   for b in select value from jsonb_array_elements(m->'blocks') loop
    insert into app_private.volume_objects(session_id,block_index,encoded_bytes,sha256)
    values(p_id,(b->>'index')::integer,(b->>'encodedBytes')::bigint,b->>'encodedSha256');
   end loop;
   update public.upload_sessions set state='uploading' where id=p_id;
  end if;
 elsif p_action='account' then
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p_owner,'role','authenticated')::text,true);
  return public.ss_account();
 elsif p_action='list' then
  select coalesce(jsonb_agg(app_private.file_json(f)||jsonb_build_object('sessionId',
   (select id from public.upload_sessions where file_id=f.id)) order by f.created_at desc),'[]') into result
  from (select f.* from public.files f join app_private.volume_sessions vs on vs.session_id=
   (select id from public.upload_sessions where file_id=f.id) where f.owner_id=p_owner and f.state='ready'
   order by f.created_at desc,f.id desc limit 50) f;
  return result;
 end if;
 select * into s from public.upload_sessions where id=p_id and owner_id=p_owner for update;
 select * into v from app_private.volume_sessions where session_id=s.id and owner_id=p_owner;
 if not found then raise exception 'NOT_FOUND'; end if;
 if p_action='read' then
  if not exists(select 1 from public.files where id=s.file_id and state='ready') or s.state<>'completed'
  then raise exception 'NOT_FOUND'; end if;
 elsif p_action='read-open' then
  if s.state<>'completed' or not exists(select 1 from public.files where id=s.file_id and state='ready')
   or not exists(select 1 from app_private.volume_objects where session_id=s.id
    and id=(p_data->>'objectId')::uuid and state='complete')
  then raise exception 'NOT_FOUND'; end if;
  insert into app_private.volume_readers(reader_id,session_id,object_id)
   values((p_data->>'readerId')::uuid,s.id,(p_data->>'objectId')::uuid);
  return jsonb_build_object('readerId',p_data->>'readerId');
 elsif p_action='read-close' then
  update app_private.volume_readers set closed=true where reader_id=(p_data->>'readerId')::uuid and session_id=s.id;
  return jsonb_build_object('closed',true);
 elsif p_action='cleanup-ready' then
  if s.state not in('cancelling','expired') and not exists(select 1 from public.files where id=s.file_id and state in('deleting','deleted'))
  then raise exception 'SESSION_BLOCKED'; end if;
  if exists(select 1 from app_private.volume_readers where session_id=s.id and not closed)
  then raise exception 'READERS_ACTIVE'; end if;
 elsif p_action='claim' then
  if s.state<>'uploading' or not s.slot_held or s.lease_expires_at<=clock_timestamp()
   or v.volume_id is distinct from (p_data->>'volumeId')::uuid then raise exception 'SESSION_BLOCKED'; end if;
  if exists(select 1 from app_private.volume_objects where session_id=s.id and state='writing') then raise exception 'ATTEMPT_AMBIGUOUS'; end if;
  select * into o from app_private.volume_objects where session_id=s.id and block_index=(p_data->>'index')::integer for update;
  if not found or o.state<>'pending' then raise exception 'REPLAY_DENIED'; end if;
  if (select coalesce(sum(encoded_bytes),0) from app_private.volume_objects where session_id=s.id)+octet_length(v.manifest_text)>s.held_bytes
  then raise exception 'ACCOUNTING_LIMIT'; end if;
  update app_private.volume_objects set state='writing',executor_id=(p_data->>'executorId')::uuid where id=o.id;
 elsif p_action='receipt' then
  select * into o from app_private.volume_objects where session_id=s.id and id=(p_data->>'objectId')::uuid for update;
  if not found or o.executor_id is distinct from (p_data->>'executorId')::uuid
   or o.encoded_bytes is distinct from (p_data->>'bytes')::bigint or o.sha256 is distinct from p_data->>'sha256'
   or v.volume_id is distinct from (p_data->>'volumeId')::uuid then raise exception 'EVIDENCE_MISMATCH'; end if;
  if o.state='complete' then return jsonb_build_object('receiptId',o.receipt_id); end if;
  if o.state<>'writing' or s.state not in('uploading','cancelling','expired') then raise exception 'SESSION_BLOCKED'; end if;
  update app_private.volume_objects set state='complete',receipt_id=gen_random_uuid() where id=o.id;
 elsif p_action='publish' then
  if s.state='completed' then return jsonb_build_object('fileId',s.file_id,'state','completed'); end if;
  if s.state<>'uploading' or s.lease_expires_at<=clock_timestamp() or not s.slot_held
   or exists(select 1 from app_private.volume_objects where session_id=s.id and state<>'complete')
  then raise exception 'FINALIZATION_BLOCKED'; end if;
  select sum(encoded_bytes) into encoded from app_private.volume_objects where session_id=s.id;
  manifest_size:=octet_length(v.manifest_text); stored:=encoded+manifest_size;
  if stored>s.held_bytes then raise exception 'ACCOUNTING_LIMIT'; end if;
  insert into app_private.volume_settlements values(s.id,p_owner,'commit',s.held_bytes,stored,default);
  insert into public.file_manifests values(s.file_id,s.id,p_owner,v.manifest,v.manifest_sha256,
   s.manifest_path,manifest_size,clock_timestamp());
  update public.files set state='ready',encoded_payload_bytes=encoded,manifest_bytes=manifest_size,stored_bytes=stored,
   manifest_sha256=v.manifest_sha256,manifest_path=s.manifest_path,block_count=jsonb_array_length(v.manifest->'blocks'),
   ready_at=clock_timestamp(),revision=revision+1 where id=s.file_id;
  update public.user_usage set stored_bytes=stored_bytes+stored,reserved_bytes=reserved_bytes-s.held_bytes,
   active_slots=active_slots-1,historical_original_bytes=historical_original_bytes+(v.manifest->>'originalBytes')::bigint,
   historical_stored_bytes=historical_stored_bytes+stored,revision=revision+1 where owner_id=p_owner;
  insert into public.usage_events(owner_id,session_id,file_id,event_key,kind,stored_delta,reserved_delta,slot_delta)
   values(p_owner,s.id,s.file_id,'volume-commit:'||s.id,'commit',stored,-s.held_bytes,-1);
  update public.upload_sessions set state='completed',held_bytes=0,slot_held=false,revision=revision+1 where id=s.id;
  return jsonb_build_object('fileId',s.file_id,'state','completed');
 elsif p_action='cancel' then
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p_owner,'role','authenticated')::text,true);
  perform public.ss_cancel(s.id);
 elsif p_action='delete' then
  perform set_config('request.jwt.claims',jsonb_build_object('sub',p_owner,'role','authenticated')::text,true);
  perform public.ss_delete_file(s.file_id);
 elsif p_action='removed' then
  if exists(select 1 from app_private.volume_readers where session_id=s.id and not closed)
  then raise exception 'READERS_ACTIVE'; end if;
  if s.state not in('cancelling','expired') and not (s.state='completed' and exists(
   select 1 from public.files where id=s.file_id and state='deleting')) then raise exception 'SESSION_BLOCKED'; end if;
  select * into o from app_private.volume_objects where session_id=s.id and id=(p_data->>'objectId')::uuid for update;
  if not found or v.volume_id is distinct from (p_data->>'volumeId')::uuid
   or (o.state<>'pending' and o.executor_id is distinct from (p_data->>'executorId')::uuid)
  then raise exception 'EVIDENCE_MISMATCH'; end if;
  update app_private.volume_objects set state='removed',removal_id=coalesce(removal_id,gen_random_uuid()) where id=o.id;
 elsif p_action='settle' then
  if s.state='settled' then return jsonb_build_object('state','settled'); end if;
  if s.state not in('cancelling','expired') or exists(select 1 from app_private.volume_objects where session_id=s.id and state<>'removed')
  then raise exception 'CLEANUP_PROOF_REQUIRED'; end if;
  insert into app_private.volume_settlements values(s.id,p_owner,'release',s.held_bytes,0,default);
  update public.user_usage set reserved_bytes=reserved_bytes-s.held_bytes,active_slots=active_slots-1,revision=revision+1 where owner_id=p_owner;
  insert into public.usage_events(owner_id,session_id,file_id,event_key,kind,reserved_delta,slot_delta)
   values(p_owner,s.id,s.file_id,'volume-release:'||s.id,'release',-s.held_bytes,-1);
  update public.upload_sessions set state='settled',held_bytes=0,slot_held=false,revision=revision+1 where id=s.id;
  update public.files set state='deleted',revision=revision+1 where id=s.file_id;
  update public.cleanup_jobs set state='done' where session_id=s.id;
 elsif p_action='settle-delete' then
  if exists(select 1 from app_private.volume_deletions where session_id=s.id) then return jsonb_build_object('state','deleted'); end if;
  if s.state<>'completed' or not exists(select 1 from public.files where id=s.file_id and state='deleting')
   or exists(select 1 from app_private.volume_objects where session_id=s.id and state<>'removed')
  then raise exception 'CLEANUP_PROOF_REQUIRED'; end if;
  select stored_bytes into stored from public.files where id=s.file_id;
  insert into app_private.volume_deletions values(s.id,p_owner,stored,default);
  update public.user_usage set stored_bytes=stored_bytes-stored,revision=revision+1 where owner_id=p_owner;
  insert into public.usage_events(owner_id,session_id,file_id,event_key,kind,stored_delta)
   values(p_owner,s.id,s.file_id,'volume-delete:'||s.id,'delete',-stored);
  update public.files set state='deleted',revision=revision+1 where id=s.file_id;
  update public.cleanup_jobs set state='done' where session_id=s.id;
 elsif p_action not in('begin','status','read') then raise exception 'INVALID_INPUT';
 end if;
 select jsonb_build_object('id',s.id,'fileId',s.file_id,'state',us.state,'heldBytes',us.held_bytes::text,
  'volumeId',v.volume_id,'manifest',v.manifest,'objects',(select jsonb_agg(jsonb_build_object(
   'id',ob.id,'index',ob.block_index,'bytes',ob.encoded_bytes,'sha256',ob.sha256,'state',ob.state,
   'executorId',ob.executor_id,'receiptId',ob.receipt_id) order by ob.block_index)
   from app_private.volume_objects ob where ob.session_id=s.id)) into result
 from public.upload_sessions us where us.id=s.id;
 return result;
end $$;
alter table app_private.volume_sessions enable row level security;
alter table app_private.volume_objects enable row level security;
alter table app_private.volume_settlements enable row level security;
alter table app_private.volume_deletions enable row level security;
alter table app_private.volume_readers enable row level security;
revoke all on app_private.volume_sessions,app_private.volume_objects,app_private.volume_settlements,app_private.volume_deletions,app_private.volume_readers from public,anon,authenticated,service_role,ss_volume_gateway;
revoke all on function app_private.volume_no_alternate_writer() from public,anon,authenticated,service_role;
revoke all on function app_private.volume_object_transition() from public,anon,authenticated,service_role;
revoke all on function public.ss_volume_command(uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant usage on schema public to ss_volume_gateway;
grant execute on function public.ss_volume_command(uuid,text,uuid,jsonb) to ss_volume_gateway;
commit;
