-- Phase 2.12A: LOCAL ONLY. Do not apply to a hosted project.
-- The migration administrator owns these definers; never transfer them to an
-- API/login role. The new NOLOGIN role receives RPC execution only, and is NOT
-- granted to service_role, authenticated, or any login by this migration.
begin;
create role ss_gateway_executor nologin noinherit;

create table app_private.gateway_accounts (
  owner_id uuid primary key references public.user_usage(owner_id),
  max_active_streams integer not null default 0 check (max_active_streams between 0 and 2),
  bucket text not null check (octet_length(bucket) between 1 and 100 and bucket ~ '^[a-z0-9][a-z0-9_-]*$')
);
-- No seed: a local administrator must explicitly configure an account/bucket.
create table app_private.gateway_sessions (
  session_id uuid primary key,
  owner_id uuid not null,
  contract_version integer not null default 1 check (contract_version = 1),
  stream_limit integer not null default 1 check (stream_limit = 1),
  foreign key (session_id,owner_id) references public.upload_sessions(id,owner_id)
);
alter table public.transfer_attempts add constraint attempts_gateway_membership
  unique (id,block_id,session_id,owner_id);
create table app_private.gateway_requests (
  request_id uuid primary key,
  attempt_id uuid not null unique,
  block_id uuid not null,
  session_id uuid not null references app_private.gateway_sessions(session_id),
  file_id uuid not null,
  owner_id uuid not null,
  foreign key (attempt_id,block_id,session_id,owner_id)
    references public.transfer_attempts(id,block_id,session_id,owner_id),
  foreign key (session_id,file_id,owner_id) references public.upload_sessions(id,file_id,owner_id),
  contract_version integer not null default 1 check (contract_version = 1),
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  descriptor_digest text not null check (descriptor_digest ~ '^[a-f0-9]{64}$'),
  epoch bigint not null check (epoch between 1 and 9007199254740991),
  declared_bytes bigint not null check (declared_bytes between 0 and 8388608),
  bucket text not null,
  object_path text not null,
  unique (bucket,object_path),
  executor_id uuid not null,
  dispatch_generation bigint not null default 1 check (dispatch_generation = 1),
  slot_held boolean not null default true check (slot_held),
  claimed_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz
);
create unique index gateway_one_stream_per_session on app_private.gateway_requests(session_id) where slot_held;
create index gateway_account_occupancy on app_private.gateway_requests(owner_id) where slot_held;
-- There is intentionally NO terminal/release path in this milestone. Expiry,
-- cancellation, epoch changes and lost acknowledgments retain every occupied slot.
alter table app_private.gateway_accounts enable row level security;
alter table app_private.gateway_sessions enable row level security;
alter table app_private.gateway_requests enable row level security;
revoke all on app_private.gateway_accounts, app_private.gateway_sessions, app_private.gateway_requests
  from public, anon, authenticated, service_role, ss_gateway_executor;

create function app_private.gateway_identity_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'GATEWAY_HISTORY_IMMUTABLE'; end if;
  if tg_table_name = 'gateway_requests' then
    if (to_jsonb(new) - 'dispatched_at') is distinct from (to_jsonb(old) - 'dispatched_at')
       or old.dispatched_at is not null or new.dispatched_at is null then
      raise exception 'GATEWAY_HISTORY_IMMUTABLE';
    end if;
  elsif tg_table_name = 'gateway_sessions' then
    raise exception 'GATEWAY_HISTORY_IMMUTABLE';
  elsif tg_table_name = 'upload_sessions' then
    if (old.id,old.file_id,old.owner_id,old.manifest_path) is distinct from
       (new.id,new.file_id,new.owner_id,new.manifest_path) then raise exception 'SESSION_IDENTITY_IMMUTABLE'; end if;
    if new.epoch < old.epoch then raise exception 'STALE_EPOCH'; end if;
    if exists (select 1 from app_private.gateway_sessions where session_id=old.id)
       and (new.held_bytes < old.held_bytes or not new.slot_held or new.state in ('completed','settled')) then
      raise exception 'EVIDENCE_REQUIRED';
    end if;
  elsif tg_table_name = 'file_blocks' then
    if (to_jsonb(old) - 'state') is distinct from (to_jsonb(new) - 'state') then
      raise exception 'BLOCK_IDENTITY_IMMUTABLE';
    end if;
  elsif tg_table_name = 'transfer_attempts' then
    if old.attempt_number is distinct from new.attempt_number then raise exception 'ATTEMPT_HISTORY_IMMUTABLE'; end if;
    if exists (select 1 from app_private.gateway_sessions where session_id=old.session_id)
       and new.state in ('present','settled') then raise exception 'EVIDENCE_REQUIRED'; end if;
  end if;
  return new;
end $$;
-- SECURITY DEFINER is needed here because ordinary metadata RPCs run as their
-- trusted owner, while direct owner SELECT remains governed by existing RLS.
alter function app_private.gateway_identity_guard() security definer;
create trigger gateway_request_identity before update or delete on app_private.gateway_requests
  for each row execute function app_private.gateway_identity_guard();
create trigger gateway_session_identity before update or delete on app_private.gateway_sessions
  for each row execute function app_private.gateway_identity_guard();
create trigger gateway_session_fence before update on public.upload_sessions
  for each row execute function app_private.gateway_identity_guard();
create trigger gateway_block_identity before update on public.file_blocks
  for each row execute function app_private.gateway_identity_guard();
create trigger gateway_attempt_identity before update on public.transfer_attempts
  for each row execute function app_private.gateway_identity_guard();

-- Close the legacy begin-request route for enrolled sessions, including zero-byte
-- attempts whose attempted_bytes remain zero. Legacy proof/settlement updates
-- above also fail closed for enrolled sessions; other sessions keep 001-003 APIs.
create function app_private.gateway_legacy_request_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.transfer_attempts a join app_private.gateway_sessions g
             on g.session_id=a.session_id where a.id=new.attempt_id) then
    raise exception 'GATEWAY_V1_REQUIRED';
  end if;
  return new;
end $$;
create trigger gateway_no_legacy_request before insert on app_private.attempt_requests
  for each row execute function app_private.gateway_legacy_request_guard();

-- All calls use the common account -> session -> file -> block -> attempt lock
-- order. Reject snapshot isolation: the account-wide count needs a fresh snapshot
-- after a competing transaction releases the user_usage lock.
create function app_private.gateway_lock_attempt(p_owner uuid,p_attempt uuid)
returns public.transfer_attempts language plpgsql set search_path = '' as $$
declare a public.transfer_attempts;
begin
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'READ_COMMITTED_REQUIRED'; end if;
  select * into a from public.transfer_attempts where id=p_attempt and owner_id=p_owner;
  if not found then raise exception 'FORBIDDEN'; end if;
  perform 1 from public.user_usage where owner_id=p_owner for update;
  perform 1 from public.upload_sessions where id=a.session_id and owner_id=p_owner for update;
  perform 1 from public.files where id=(select file_id from public.upload_sessions where id=a.session_id) for update;
  perform 1 from public.file_blocks where id=a.block_id for update;
  select * into strict a from public.transfer_attempts where id=p_attempt and owner_id=p_owner for update;
  return a;
end $$;

create function public.ss_gateway_claim_v1(
  p_owner uuid,p_attempt uuid,p_request uuid,p_declared_bytes bigint,p_executor uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.transfer_attempts; s public.upload_sessions; b public.file_blocks;
  c app_private.gateway_accounts; r app_private.gateway_requests;
  fingerprint text; descriptor text; t timestamptz;
begin
  if p_owner is null or p_attempt is null or p_request is null or p_executor is null
     or p_declared_bytes is null or p_declared_bytes not between 0 and 8388608 then raise exception 'INVALID_INPUT'; end if;
  a := app_private.gateway_lock_attempt(p_owner,p_attempt);
  select * into strict s from public.upload_sessions where id=a.session_id;
  select * into strict b from public.file_blocks where id=a.block_id;
  descriptor := encode(sha256(convert_to(jsonb_build_array(b.id,b.file_id,b.session_id,b.owner_id,
    b.block_index,b.original_offset,b.original_bytes,b.encoded_bytes,b.codec,b.original_sha256,b.encoded_sha256)::text,'UTF8')),'hex');
  fingerprint := encode(sha256(convert_to(jsonb_build_array(1,'claim',p_owner,a.id,s.id,s.file_id,
    a.epoch,a.object_path,descriptor,p_declared_bytes,p_executor)::text,'UTF8')),'hex');
  select * into r from app_private.gateway_requests where request_id=p_request;
  if found then
    if r.owner_id is distinct from p_owner or r.attempt_id is distinct from a.id
       or r.input_digest is distinct from fingerprint then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    -- Even a never-dispatched claim replay gives no second stream authority.
    return jsonb_build_object('contractVersion',1,'kind','ambiguous','requestId',r.request_id);
  end if;
  if exists (select 1 from app_private.gateway_requests where attempt_id=a.id)
     or a.attempted_bytes<>0 or a.acknowledged_bytes<>0 or a.observed_bytes is not null
     or exists (select 1 from app_private.attempt_requests r0 join public.transfer_attempts a0
                on a0.id=r0.attempt_id where a0.session_id=s.id)
     or exists (select 1 from public.transfer_attempts a0 where a0.session_id=s.id and a0.id<>a.id
                and (a0.state<>'authorized' or a0.attempted_bytes<>0 or a0.observed_bytes is not null)) then
    raise exception 'ATTEMPT_AMBIGUOUS';
  end if;
  if a.epoch<>s.epoch or s.epoch not between 1 and 9007199254740991 then raise exception 'STALE_EPOCH'; end if;
  t := clock_timestamp();
  if s.lease_expires_at<=t or a.expires_at<=t then raise exception 'EXPIRED'; end if;
  if s.state<>'uploading' or not s.slot_held or a.state<>'authorized' or b.state<>'allocated'
     or not exists(select 1 from public.files where id=s.file_id and state='uploading') then raise exception 'SESSION_BLOCKED'; end if;
  if p_declared_bytes<>a.authorized_max_bytes or p_declared_bytes<>b.encoded_bytes then raise exception 'INVALID_LENGTH'; end if;
  -- All historical attempts count conservatively; no receipt-based removal exists
  -- yet. Include the full manifest allowance, including the zero-byte case.
  if (select coalesce(sum(authorized_max_bytes::numeric),0)+131072 from public.transfer_attempts where session_id=s.id)>s.held_bytes then
    raise exception 'ACCOUNTING_LIMIT';
  end if;
  select * into c from app_private.gateway_accounts where owner_id=p_owner for update;
  if not found then raise exception 'CAPACITY_EXCEEDED'; end if;
  if (select count(*) from app_private.gateway_requests where owner_id=p_owner and slot_held)>=c.max_active_streams
     or exists(select 1 from app_private.gateway_requests where session_id=s.id and slot_held) then raise exception 'CAPACITY_EXCEEDED'; end if;
  insert into app_private.gateway_sessions(session_id,owner_id) values(s.id,p_owner) on conflict do nothing;
  insert into app_private.gateway_requests(request_id,attempt_id,block_id,session_id,file_id,owner_id,input_digest,
    descriptor_digest,epoch,declared_bytes,bucket,object_path,executor_id)
    values(p_request,a.id,b.id,s.id,s.file_id,p_owner,fingerprint,descriptor,a.epoch,p_declared_bytes,c.bucket,a.object_path,p_executor);
  update public.transfer_attempts set attempted_bytes=attempted_bytes+p_declared_bytes,state='in_flight' where id=a.id;
  return jsonb_build_object('contractVersion',1,'kind','claimed','requestId',p_request,'dispatchGeneration','1',
    'authority',jsonb_build_object('ownerId',p_owner,'sessionId',s.id,'attemptId',a.id,'epoch',a.epoch::text,
      'bucket',c.bucket,'path',a.object_path,'maximumEncodedBytes',p_declared_bytes::text));
end $$;

create function public.ss_gateway_dispatch_v1(p_owner uuid,p_request uuid,p_executor uuid,p_epoch bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.transfer_attempts; s public.upload_sessions; r app_private.gateway_requests; t timestamptz;
begin
  select * into r from app_private.gateway_requests where request_id=p_request and owner_id=p_owner;
  if not found then raise exception 'FORBIDDEN'; end if;
  a := app_private.gateway_lock_attempt(p_owner,r.attempt_id);
  select * into strict s from public.upload_sessions where id=a.session_id;
  select * into strict r from app_private.gateway_requests where request_id=p_request for update;
  if r.executor_id is distinct from p_executor then raise exception 'FORBIDDEN'; end if;
  if p_epoch is distinct from r.epoch or p_epoch is distinct from s.epoch then raise exception 'STALE_EPOCH'; end if;
  if r.dispatched_at is not null then raise exception 'ALREADY_DISPATCHED'; end if;
  t := clock_timestamp();
  if s.lease_expires_at<=t or a.expires_at<=t then raise exception 'EXPIRED'; end if;
  if s.state<>'uploading' or a.state<>'in_flight' or not s.slot_held then raise exception 'SESSION_BLOCKED'; end if;
  update app_private.gateway_requests set dispatched_at=t where request_id=p_request;
  return jsonb_build_object('contractVersion',1,'kind','dispatch_granted','requestId',p_request,
    'executorId',r.executor_id,'epoch',r.epoch::text,'dispatchGeneration',r.dispatch_generation::text,
    'bucket',r.bucket,'path',r.object_path,'declaredBytes',r.declared_bytes::text);
end $$;

revoke all on function app_private.gateway_identity_guard(), app_private.gateway_legacy_request_guard(),
  app_private.gateway_lock_attempt(uuid,uuid) from public,anon,authenticated,service_role,ss_gateway_executor;
revoke all on function public.ss_gateway_claim_v1(uuid,uuid,uuid,bigint,uuid),
  public.ss_gateway_dispatch_v1(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant usage on schema public to ss_gateway_executor;
grant execute on function public.ss_gateway_claim_v1(uuid,uuid,uuid,bigint,uuid),
  public.ss_gateway_dispatch_v1(uuid,uuid,uuid,bigint) to ss_gateway_executor;
commit;
