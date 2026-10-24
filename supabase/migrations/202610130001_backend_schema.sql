-- Reviewed local Phase 2 schema. No cloud deployment is authorized.
begin;
create schema app_private;
revoke all on schema app_private from public, anon, authenticated;
create table app_private.account_policy (
  singleton boolean primary key default true check(singleton),
  quota_bytes bigint not null check(quota_bytes >= 0),
  max_slots integer not null check(max_slots between 0 and 2)
);
-- Fail closed until a separately reviewed environment policy is configured.
insert into app_private.account_policy values(true,0,0);
create table public.profiles (
  id uuid primary key references auth.users(id),
  display_name text check(octet_length(display_name) <= 255),
  created_at timestamptz not null default now()
);
create table public.user_usage (
  owner_id uuid primary key references public.profiles(id),
  quota_bytes bigint not null check(quota_bytes>=0),
  stored_bytes bigint not null default 0 check(stored_bytes>=0),
  reserved_bytes bigint not null default 0 check(reserved_bytes>=0),
  active_slots integer not null default 0 check(active_slots>=0),
  max_slots integer not null check(max_slots between 0 and 2),
  historical_original_bytes bigint not null default 0 check(historical_original_bytes>=0),
  historical_stored_bytes bigint not null default 0 check(historical_stored_bytes>=0),
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  check(stored_bytes::numeric+reserved_bytes::numeric<=quota_bytes::numeric), check(active_slots<=max_slots)
);
create table public.files (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id), unique(id,owner_id),
  original_name text not null check(octet_length(original_name) between 1 and 255),
  display_name text not null check(octet_length(display_name) between 1 and 255),
  original_mime text check(octet_length(original_mime)<=127),
  category text not null default 'other' check(category in('document','image','video','audio','archive','other')),
  state text not null default 'uploading' check(state in('uploading','ready','failed','deleting','deleted')),
  original_bytes bigint not null check(original_bytes between 0 and 33554432),
  encoded_payload_bytes bigint check(encoded_payload_bytes>=0), manifest_bytes bigint check(manifest_bytes between 1 and 131072),
  stored_bytes bigint check(stored_bytes>=0), source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text check(manifest_sha256 ~ '^[a-f0-9]{64}$'), manifest_path text unique,
  format text not null default 'compression-spike' check(format='compression-spike'), format_version integer not null default 1 check(format_version=1),
  block_count integer check(block_count between 1 and 128), revision bigint not null default 0,
  created_at timestamptz not null default now(), ready_at timestamptz, deleted_at timestamptz,
  check(state<>'ready' or (encoded_payload_bytes is not null and manifest_bytes is not null and stored_bytes=encoded_payload_bytes+manifest_bytes and manifest_sha256 is not null and manifest_path is not null and block_count is not null and ready_at is not null))
);
create index files_owner_page on public.files(owner_id,created_at desc,id desc) where state='ready';
create table public.upload_sessions (
  id uuid primary key default gen_random_uuid(), file_id uuid not null, owner_id uuid not null,
  foreign key(file_id,owner_id) references public.files(id,owner_id), unique(id,file_id,owner_id), unique(id,owner_id),
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9_-]{16,80}$'), request_digest text not null,
  unique(owner_id,idempotency_key), state text not null default 'reserved' check(state in('reserved','uploading','reconciling','finalizing','completed','cancelling','expired','settled')),
  held_bytes bigint not null check(held_bytes>=0), slot_held boolean not null default true, epoch bigint not null default 1 check(epoch>=1),
  lease_expires_at timestamptz not null, cleanup_after timestamptz,
  initial_source_sha256 text not null check(initial_source_sha256 ~ '^[a-f0-9]{64}$'), terminal_reason text,
  manifest_path text not null unique,
  revision bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index sessions_one_unsettled_file on public.upload_sessions(file_id) where state<>'settled';
create index sessions_owner on public.upload_sessions(owner_id,created_at desc,id desc);
create index sessions_expiry on public.upload_sessions(state,lease_expires_at);
create table public.file_blocks (
  id uuid primary key default gen_random_uuid(), file_id uuid not null, session_id uuid not null, owner_id uuid not null,
  foreign key(session_id,file_id,owner_id) references public.upload_sessions(id,file_id,owner_id), unique(id,session_id,owner_id),
  block_index integer not null check(block_index between 0 and 127), unique(file_id,block_index),
  original_offset bigint not null check(original_offset>=0), original_bytes bigint not null check(original_bytes between 0 and 8388608),
  encoded_bytes bigint not null check(encoded_bytes>=0 and encoded_bytes<=original_bytes), codec text not null check(codec in('raw','gzip')),
  original_sha256 text not null check(original_sha256 ~ '^[a-f0-9]{64}$'), encoded_sha256 text not null check(encoded_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null default 'allocated' check(state in('allocated','present','deleting','deleted')),
  check((codec='raw' and encoded_bytes=original_bytes) or (codec='gzip' and original_bytes>0 and encoded_bytes>=18))
);
create table public.transfer_attempts (
  id uuid primary key default gen_random_uuid(), block_id uuid not null, session_id uuid not null, owner_id uuid not null,
  foreign key(block_id,session_id,owner_id) references public.file_blocks(id,session_id,owner_id),
  attempt_number integer not null default 1 check(attempt_number>=1), unique(block_id,attempt_number), epoch bigint not null,
  object_path text not null unique, authorized_max_bytes bigint not null check(authorized_max_bytes>=0),
  attempted_bytes bigint not null default 0 check(attempted_bytes>=0), acknowledged_bytes bigint not null default 0 check(acknowledged_bytes>=0 and acknowledged_bytes<=authorized_max_bytes),
  observed_bytes bigint check(observed_bytes>=0 and observed_bytes<=authorized_max_bytes),
  state text not null default 'authorized' check(state in('authorized','in_flight','ambiguous','present','fenced','deleting','settled')),
  provider_verified_at timestamptz, expires_at timestamptz not null, created_at timestamptz not null default now(),
  check(state<>'present' or (observed_bytes is not null and provider_verified_at is not null))
);
create index attempts_session_state on public.transfer_attempts(session_id,state);
create table public.file_manifests (
  file_id uuid primary key, session_id uuid not null, owner_id uuid not null,
  foreign key(session_id,file_id,owner_id) references public.upload_sessions(id,file_id,owner_id),
  manifest jsonb not null check(octet_length(manifest::text)<=131072), sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  object_path text not null unique, observed_bytes bigint not null check(observed_bytes between 1 and 131072),
  provider_verified_at timestamptz not null
);
create table public.usage_events (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id),
  session_id uuid, file_id uuid, event_key text not null, unique(owner_id,event_key),
  foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id), foreign key(file_id,owner_id) references public.files(id,owner_id),
  kind text not null check(kind in('reserve','commit','release','delete','correction')),
  stored_delta bigint not null default 0, reserved_delta bigint not null default 0, slot_delta integer not null default 0,
  created_at timestamptz not null default now()
);
create table public.cleanup_jobs (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, session_id uuid, file_id uuid,
  foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id), foreign key(file_id,owner_id) references public.files(id,owner_id),
  kind text not null check(kind in('cancel','delete')), state text not null default 'queued' check(state in('queued','leased','blocked','done')),
  attempts integer not null default 0 check(attempts>=0), lease_epoch bigint not null default 0, lease_until timestamptz,
  next_attempt_at timestamptz not null default now(), last_error_code text, created_at timestamptz not null default now()
);
create unique index cleanup_unique_session on public.cleanup_jobs(session_id,kind) where state<>'done';
create unique index cleanup_unique_file on public.cleanup_jobs(file_id,kind) where state<>'done';
create index cleanup_due on public.cleanup_jobs(state,next_attempt_at);
create function app_private.owner_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if old.owner_id is distinct from new.owner_id then raise exception 'OWNER_IMMUTABLE'; end if;
  return new;
end $$;
create function app_private.file_transition() returns trigger language plpgsql set search_path='' as $$
begin
  if (old.id,old.owner_id,old.original_name,old.original_mime,old.original_bytes,old.source_sha256,old.format,old.format_version,old.created_at) is distinct from (new.id,new.owner_id,new.original_name,new.original_mime,new.original_bytes,new.source_sha256,new.format,new.format_version,new.created_at) then raise exception 'FILE_SOURCE_IMMUTABLE'; end if;
  if old.state<>new.state and not ((old.state='uploading' and new.state in('ready','failed','deleting')) or (old.state in('ready','failed') and new.state='deleting') or (old.state='deleting' and new.state='deleted')) then raise exception 'FILE_TRANSITION_INVALID'; end if;
  return new;
end $$;
create trigger file_transition before update on public.files for each row execute function app_private.file_transition();
create function app_private.attempt_counters() returns trigger language plpgsql set search_path='' as $$
begin
  if new.attempted_bytes<old.attempted_bytes or new.acknowledged_bytes<old.acknowledged_bytes or (old.id,old.block_id,old.session_id,old.owner_id,old.epoch,old.object_path,old.authorized_max_bytes) is distinct from (new.id,new.block_id,new.session_id,new.owner_id,new.epoch,new.object_path,new.authorized_max_bytes) then raise exception 'ATTEMPT_HISTORY_IMMUTABLE'; end if;
  return new;
end $$;
create trigger attempt_counters before update on public.transfer_attempts for each row execute function app_private.attempt_counters();
do $$ declare t text; begin
  foreach t in array array['user_usage','files','upload_sessions','file_blocks','transfer_attempts','file_manifests','usage_events','cleanup_jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('create trigger owner_immutable before update on public.%I for each row execute function app_private.owner_immutable()',t);
  end loop;
end $$;
alter table public.profiles enable row level security;
revoke all on public.profiles from public,anon,authenticated;
revoke all on all tables in schema app_private from public,anon,authenticated;
commit;
