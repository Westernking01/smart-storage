-- Phase 2.13B LOCAL ONLY. No provider capabilities are approved or seeded.
-- Verification records are an administrator-controlled import boundary, NOT
-- provider validation. No runtime role can mint them. A future reviewed verifier
-- must validate the protocol and actual evidence before importing any record.
begin;
create role ss_gateway_finalizer nologin noinherit;
create role ss_gateway_cleaner nologin noinherit;

create table app_private.gateway_protocols (
  protocol_id uuid primary key,
  namespace text not null,
  revision text not null,
  evidence_reference text not null check(length(evidence_reference) between 1 and 2048),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  unique(namespace,revision)
);
create table app_private.gateway_verifications (
  verification_id uuid primary key,
  protocol_id uuid not null references app_private.gateway_protocols,
  owner_id uuid not null,
  session_id uuid not null,
  decision_epoch bigint not null,
  membership_digest text not null check(membership_digest ~ '^[a-f0-9]{64}$'),
  kind text not null check(kind in ('membership','terminal','present','absence','manifest')),
  resource_id uuid,
  observation_id uuid references app_private.gateway_observation_receipts,
  terminal_id uuid references app_private.gateway_verifications,
  -- Covers the entire immutable request/grant set, including escaped grants.
  writer_digest text not null check(writer_digest ~ '^[a-f0-9]{64}$'),
  content_sha256 text check(content_sha256 ~ '^[a-f0-9]{64}$'),
  accepted_bytes bigint check(accepted_bytes>=0),
  acknowledged_bytes bigint check(acknowledged_bytes>=0),
  serialized_manifest bytea check(octet_length(serialized_manifest) between 1 and 131072),
  evidence_reference text not null check(length(evidence_reference) between 1 and 2048),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  -- Audited provider barrier/protocol reference establishes causality; clocks do not.
  barrier_reference text not null check(length(barrier_reference) between 1 and 2048),
  received_at timestamptz not null default clock_timestamp(),
  foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id),
  foreign key(resource_id,owner_id,session_id) references app_private.gateway_resources(resource_id,owner_id,session_id),
  check((kind='membership' and resource_id is null) or (kind<>'membership' and resource_id is not null)),
  check(kind not in ('present','absence','manifest') or (observation_id is not null and terminal_id is not null)),
  check(kind<>'manifest' or serialized_manifest is not null)
);
create index gateway_verifications_session on app_private.gateway_verifications(session_id,kind);
create table app_private.gateway_invalidations (
  invalidation_id uuid primary key,
  session_id uuid not null references app_private.gateway_sessions,
  evidence_reference text not null,
  created_at timestamptz not null default clock_timestamp()
);
create table app_private.gateway_preparations (
  preparation_id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references app_private.gateway_sessions,
  owner_id uuid not null,
  operation_key uuid not null,
  decision_epoch bigint not null,
  session_revision bigint not null,
  membership_digest text not null,
  input_digest text not null,
  selection jsonb not null,
  manifest_verification uuid not null references app_private.gateway_verifications,
  membership_verification uuid not null references app_private.gateway_verifications,
  payload_bytes bigint not null check(payload_bytes>=0),
  manifest_bytes bigint not null check(manifest_bytes between 1 and 131072),
  state text not null default 'prepared' check(state='prepared'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id),
  unique(owner_id,operation_key)
);
create table app_private.gateway_cleanup_snapshots (
  job_id uuid primary key references public.cleanup_jobs,
  session_id uuid not null unique references app_private.gateway_sessions,
  owner_id uuid not null,
  decision_epoch bigint not null,
  membership_digest text not null,
  foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id)
);
create table app_private.gateway_cleanup_members (
  job_id uuid not null references app_private.gateway_cleanup_snapshots,
  resource_id uuid not null references app_private.gateway_resources,
  primary key(job_id,resource_id)
);
create table app_private.gateway_removals (
  job_id uuid not null,
  resource_id uuid not null,
  lease_epoch bigint not null,
  terminal_id uuid not null references app_private.gateway_verifications,
  absence_id uuid not null references app_private.gateway_verifications,
  operation_key uuid not null,
  primary key(job_id,resource_id,lease_epoch),
  unique(job_id,operation_key),
  foreign key(job_id,resource_id) references app_private.gateway_cleanup_members
);
create table app_private.gateway_settlements (
  job_id uuid primary key references app_private.gateway_cleanup_snapshots,
  owner_id uuid not null,
  session_id uuid not null unique,
  lease_epoch bigint not null,
  operation_key uuid not null,
  membership_verification uuid not null references app_private.gateway_verifications,
  released_bytes bigint not null check(released_bytes>=0),
  released_slots integer not null check(released_slots between 0 and 1),
  result jsonb not null,
  foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id),
  unique(owner_id,operation_key)
);
-- Every sidecar is private and append-only, including completed decisions.
do $$ declare t text; begin
 foreach t in array array['gateway_protocols','gateway_verifications','gateway_invalidations',
 'gateway_preparations','gateway_cleanup_snapshots','gateway_cleanup_members','gateway_removals','gateway_settlements'] loop
  execute format('alter table app_private.%I enable row level security',t);
  execute format('revoke all on app_private.%I from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner',t);
  execute format('create trigger immutable before update or delete on app_private.%I for each row execute function app_private.gateway_evidence_immutable()',t);
 end loop;
end $$;

create function app_private.gateway_lock_session(p_owner uuid,p_session uuid)
returns public.upload_sessions language plpgsql set search_path='' as $$
declare s public.upload_sessions; begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'READ_COMMITTED_REQUIRED'; end if;
 if not exists(select 1 from app_private.gateway_sessions where session_id=p_session and owner_id=p_owner) then raise exception 'FORBIDDEN'; end if;
 perform 1 from public.user_usage where owner_id=p_owner for update;
 select * into strict s from public.upload_sessions where id=p_session and owner_id=p_owner for update;
 perform 1 from public.files where id=s.file_id for update;
 perform 1 from public.file_blocks where session_id=s.id order by id for update;
 perform 1 from public.transfer_attempts where session_id=s.id order by id for update;
 return s;
end $$;
create function app_private.gateway_membership_digest(p_session uuid) returns text
language sql stable set search_path='' as $$
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.resource_id),'[]'::jsonb)::text,'UTF8')),'hex')
 from app_private.gateway_resources r where r.session_id=p_session
$$;
create function app_private.gateway_writer_digest(p_session uuid) returns text
language sql stable set search_path='' as $$
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.request_id),'[]'::jsonb)::text,'UTF8')),'hex')
 from app_private.gateway_requests r where r.session_id=p_session
$$;
create function app_private.gateway_check_membership(p_session uuid) returns void
language plpgsql set search_path='' as $$
declare s public.upload_sessions; begin
 select * into strict s from public.upload_sessions where id=p_session;
 if exists(select 1 from app_private.gateway_invalidations where session_id=s.id) then raise exception 'EVIDENCE_QUARANTINED'; end if;
 if not exists(select 1 from app_private.gateway_resources where session_id=s.id and kind='manifest' and object_path=s.manifest_path)
 or exists(select 1 from public.transfer_attempts a where a.session_id=s.id and not exists(
  select 1 from app_private.gateway_resources r where r.session_id=s.id and r.attempt_id=a.id and r.kind='object' and r.object_path=a.object_path))
 then raise exception 'MEMBERSHIP_INCOMPLETE'; end if;
 -- An unresolved creation intent is not silently treated as an absent object.
 -- It needs its own terminal and authoritative absence certificate below.
end $$;
create function app_private.gateway_check_verification(p_id uuid,p_session uuid,p_kind text,p_resource uuid)
returns app_private.gateway_verifications language plpgsql set search_path='' as $$
declare v app_private.gateway_verifications; s public.upload_sessions; r app_private.gateway_resources;
 o app_private.gateway_observation_receipts; t app_private.gateway_verifications; begin
 select * into strict s from public.upload_sessions where id=p_session;
 select * into v from app_private.gateway_verifications where verification_id=p_id;
 if not found or (v.owner_id,v.session_id,v.kind,v.resource_id) is distinct from (s.owner_id,s.id,p_kind,p_resource)
 then raise exception 'EVIDENCE_REQUIRED'; end if;
 if v.decision_epoch<>s.epoch then raise exception 'STALE_EPOCH'; end if;
 if v.membership_digest<>app_private.gateway_membership_digest(s.id)
 or v.writer_digest<>app_private.gateway_writer_digest(s.id) then raise exception 'MEMBERSHIP_CHANGED'; end if;
 if exists(select 1 from app_private.gateway_invalidations where session_id=s.id) then raise exception 'EVIDENCE_QUARANTINED'; end if;
 if p_kind='membership' then
  if exists(select 1 from app_private.gateway_resources resource_scope where resource_scope.session_id=s.id and not exists(
   select 1 from app_private.gateway_protocols p where p.protocol_id=v.protocol_id and p.namespace=resource_scope.scope->>'namespace'))
  then raise exception 'PROTOCOL_REQUIRED'; end if;
  return v;
 end if;
 select * into strict r from app_private.gateway_resources where resource_id=p_resource;
 if not exists(select 1 from app_private.gateway_protocols p where p.protocol_id=v.protocol_id and p.namespace=r.scope->>'namespace') then raise exception 'PROTOCOL_REQUIRED'; end if;
 if p_kind='terminal' then return v; end if;
 t:=app_private.gateway_check_verification(v.terminal_id,s.id,'terminal',p_resource);
 if t.protocol_id<>v.protocol_id then raise exception 'EVIDENCE_MISMATCH'; end if;
 select * into strict o from app_private.gateway_observation_receipts where receipt_id=v.observation_id;
 if (o.resource_id,o.owner_id,o.session_id,o.allocation_epoch,o.decision_epoch)
 is distinct from (r.resource_id,r.owner_id,r.session_id,r.allocation_epoch,s.epoch)
 or o.evidence->'scope' is distinct from r.scope then raise exception 'EVIDENCE_MISMATCH'; end if;
 -- New unknown/contradictory observations invalidate eligibility; never select an
 -- older convenient receipt from history. Received time is not provider causality.
 if exists(select 1 from app_private.gateway_observation_receipts newer where newer.resource_id=r.resource_id
 and newer.receipt_id<>o.receipt_id and newer.received_at>=o.received_at
 and (newer.outcome,newer.observed_bytes,newer.evidence) is distinct from (o.outcome,o.observed_bytes,o.evidence))
 then raise exception 'OBSERVATION_AMBIGUOUS'; end if;
 if p_kind='absence' then
  if o.outcome<>'absent' or o.evidence->>'kind'<>'absence' then raise exception 'AUTHORITATIVE_ABSENCE_REQUIRED'; end if;
 else
  if o.outcome<>'present' or o.evidence->>'kind'<>'inspection' then raise exception 'OBSERVATION_AMBIGUOUS'; end if;
  if o.observed_bytes is distinct from v.accepted_bytes or v.accepted_bytes is distinct from v.acknowledged_bytes
   or v.content_sha256 is null then raise exception 'SIZE_OR_HASH_MISMATCH'; end if;
  if r.scope->>'version' is null and r.scope->>'generation' is null then raise exception 'IMMUTABLE_IDENTITY_REQUIRED'; end if;
 end if;
 return v;
end $$;

create function public.ss_gateway_prepare_finalization_v1(
 p_owner uuid,p_session uuid,p_operation uuid,p_epoch bigint,p_selection jsonb,
 p_manifest uuid,p_membership uuid,p_payload bigint
) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; f public.files; b public.file_blocks;
 old app_private.gateway_preparations; v app_private.gateway_verifications; mv app_private.gateway_verifications;
 r app_private.gateway_resources; item jsonb; manifest jsonb; expected jsonb:='[]';
 digest text; n integer; total bigint:=0; selected uuid[]:='{}'; begin
 s:=app_private.gateway_lock_session(p_owner,p_session);
 if p_operation is null or p_epoch is null or p_payload is null or p_payload<0 or jsonb_typeof(p_selection) is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
 digest:=encode(sha256(convert_to(jsonb_build_array(p_owner,p_session,p_epoch,p_selection,p_manifest,p_membership,p_payload)::text,'UTF8')),'hex');
 select * into old from app_private.gateway_preparations where session_id=s.id;
 if found then
  if old.operation_key<>p_operation or old.input_digest<>digest then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
 end if;
 if p_epoch<>s.epoch then raise exception 'STALE_EPOCH'; end if;
 if s.state<>'uploading' or s.lease_expires_at<=clock_timestamp() then raise exception 'SESSION_BLOCKED'; end if;
 select * into strict f from public.files where id=s.file_id;
 if f.state<>'uploading' or (old.preparation_id is not null and old.session_revision<>s.revision) then raise exception 'SESSION_BLOCKED'; end if;
 perform app_private.gateway_check_membership(s.id);
 perform app_private.gateway_check_verification(p_membership,s.id,'membership',null);
 n:=greatest(1,(f.original_bytes+8388607)/8388608);
 if jsonb_array_length(p_selection)<>n or (select count(*) from public.file_blocks where session_id=s.id)<>n then raise exception 'BLOCKS_INCOMPLETE'; end if;
 for b in select * from public.file_blocks where session_id=s.id order by block_index loop
  item:=p_selection->b.block_index;
  if b.block_index>=n or b.original_offset<>b.block_index::bigint*8388608
   or b.original_bytes<>least(8388608,f.original_bytes-b.original_offset)
   or item is null or jsonb_typeof(item) is distinct from 'object' then raise exception 'BLOCKS_INCOMPLETE'; end if;
  select * into r from app_private.gateway_resources where resource_id=(item->>'resourceId')::uuid
   and session_id=s.id and kind='object';
  if not found or not exists(select 1 from public.transfer_attempts a join app_private.gateway_requests q on q.attempt_id=a.id
    where a.id=r.attempt_id and a.block_id=b.id and q.request_id=r.request_id
    and q.declared_bytes=b.encoded_bytes and a.authorized_max_bytes=b.encoded_bytes and q.dispatched_at is not null)
   or r.resource_id=any(selected) then raise exception 'BLOCK_EVIDENCE_INVALID'; end if;
  v:=app_private.gateway_check_verification((item->>'verificationId')::uuid,s.id,'present',r.resource_id);
  if v.accepted_bytes<>b.encoded_bytes or v.content_sha256<>b.encoded_sha256 then raise exception 'SIZE_OR_HASH_MISMATCH'; end if;
  selected:=array_append(selected,r.resource_id);
  expected:=expected||jsonb_build_array(jsonb_build_object('index',b.block_index,'offset',b.original_offset,
    'originalBytes',b.original_bytes,'encodedBytes',b.encoded_bytes,'codec',b.codec,
    'originalSha256',b.original_sha256,'encodedSha256',b.encoded_sha256));
  total:=total+b.encoded_bytes;
 end loop;
 select * into mv from app_private.gateway_verifications where verification_id=p_manifest;
 mv:=app_private.gateway_check_verification(p_manifest,s.id,'manifest',mv.resource_id);
 select * into strict r from app_private.gateway_resources where resource_id=mv.resource_id;
 if r.kind<>'manifest' or r.object_path<>s.manifest_path or r.resource_id=any(selected) then raise exception 'MANIFEST_INVALID'; end if;
 if mv.accepted_bytes is distinct from octet_length(mv.serialized_manifest)::bigint
 or mv.content_sha256 is distinct from encode(sha256(mv.serialized_manifest),'hex') then raise exception 'MANIFEST_INVALID'; end if;
 manifest:=convert_from(mv.serialized_manifest,'UTF8')::jsonb;
 if manifest is distinct from jsonb_build_object('format','compression-spike','version',1,'blockSize',8388608,
  'originalBytes',f.original_bytes,'originalSha256',f.source_sha256,'blocks',expected) then raise exception 'MANIFEST_INVALID'; end if;
 selected:=array_append(selected,r.resource_id);
 -- Every nonselected member, including temporary resources/intents/old attempts,
 -- must be absent. Every selected member already has a full terminal barrier.
 for r in select * from app_private.gateway_resources where session_id=s.id and not(resource_id=any(selected)) loop
  select * into v from app_private.gateway_verifications where session_id=s.id and resource_id=r.resource_id
   and kind='absence' and decision_epoch=s.epoch order by received_at desc,verification_id limit 1;
  perform app_private.gateway_check_verification(v.verification_id,s.id,'absence',r.resource_id);
 end loop;
 if total<>p_payload or total+mv.accepted_bytes>s.held_bytes then raise exception 'ACCOUNTING_LIMIT'; end if;
 if old.preparation_id is not null then return old.preparation_id; end if;
 insert into app_private.gateway_preparations(session_id,owner_id,operation_key,decision_epoch,session_revision,
 membership_digest,input_digest,selection,manifest_verification,membership_verification,payload_bytes,manifest_bytes)
 values(s.id,p_owner,p_operation,s.epoch,s.revision,app_private.gateway_membership_digest(s.id),digest,
 p_selection,p_manifest,p_membership,total,mv.accepted_bytes) returning preparation_id into digest;
 return digest::uuid;
end $$;

-- Begin records a durable snapshot and fences dispatch; it grants NO deletion
-- permission. Incomplete discovery stays blocked until verification/reconciliation.
create function public.ss_gateway_begin_cleanup_v1(p_owner uuid,p_session uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; j uuid; begin
 s:=app_private.gateway_lock_session(p_owner,p_session);
 select job_id into j from app_private.gateway_cleanup_snapshots where session_id=s.id;
 if found then return j; end if;
 if s.state not in ('uploading','reconciling','cancelling','expired') then raise exception 'CLEANUP_STATE_INVALID'; end if;
 update public.upload_sessions set state='cancelling',epoch=epoch+1,revision=revision+1 where id=s.id returning * into s;
 update public.files set state='deleting',revision=revision+1 where id=s.file_id and state<>'deleting';
 insert into public.cleanup_jobs(owner_id,session_id,file_id,kind,state) values(p_owner,s.id,s.file_id,'cancel','blocked')
 on conflict (session_id,kind) where state<>'done' do update set state='blocked' returning id into j;
 insert into app_private.gateway_cleanup_snapshots values(j,s.id,p_owner,s.epoch,app_private.gateway_membership_digest(s.id));
 insert into app_private.gateway_cleanup_members select j,resource_id from app_private.gateway_resources where session_id=s.id;
 return j;
end $$;
create function app_private.gateway_lock_cleanup(p_owner uuid,p_job uuid,p_lease bigint)
returns public.cleanup_jobs language plpgsql set search_path='' as $$
declare j public.cleanup_jobs; s public.upload_sessions; snap app_private.gateway_cleanup_snapshots; begin
 select * into snap from app_private.gateway_cleanup_snapshots where job_id=p_job and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 s:=app_private.gateway_lock_session(p_owner,snap.session_id);
 select * into strict j from public.cleanup_jobs where id=p_job for update;
 if (j.owner_id,j.session_id,j.file_id) is distinct from (p_owner,s.id,s.file_id) then raise exception 'FORBIDDEN'; end if;
 if p_lease is distinct from j.lease_epoch or j.state<>'leased' or j.lease_until<=clock_timestamp() or j.lease_until is null then raise exception 'STALE_LEASE'; end if;
 if snap.decision_epoch<>s.epoch or s.state not in ('cancelling','expired') then raise exception 'STALE_EPOCH'; end if;
 if snap.membership_digest<>app_private.gateway_membership_digest(s.id) then raise exception 'MEMBERSHIP_CHANGED'; end if;
 perform app_private.gateway_check_membership(s.id);
 if exists(select resource_id from app_private.gateway_resources where session_id=s.id except
 select resource_id from app_private.gateway_cleanup_members where job_id=j.id) then raise exception 'MEMBERSHIP_INCOMPLETE'; end if;
 return j;
end $$;
create function public.ss_gateway_lease_cleanup_v1(p_owner uuid,p_job uuid) returns bigint
language plpgsql security definer set search_path='' as $$
declare j public.cleanup_jobs; s public.upload_sessions; begin
 select * into j from public.cleanup_jobs where id=p_job and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 s:=app_private.gateway_lock_session(p_owner,j.session_id);
 select * into strict j from public.cleanup_jobs where id=p_job for update;
 if j.state='done' or (j.state='leased' and j.lease_until>clock_timestamp()) then raise exception 'LEASE_BLOCKED'; end if;
 update public.cleanup_jobs set state='leased',lease_epoch=lease_epoch+1,lease_until=clock_timestamp()+interval '5 minutes'
 where id=j.id returning lease_epoch into j.lease_epoch;
 return j.lease_epoch;
end $$;
create function public.ss_gateway_record_removal_v1(p_owner uuid,p_job uuid,p_lease bigint,
 p_resource uuid,p_terminal uuid,p_absence uuid,p_operation uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare j public.cleanup_jobs; v app_private.gateway_verifications; old app_private.gateway_removals; begin
 j:=app_private.gateway_lock_cleanup(p_owner,p_job,p_lease);
 if p_operation is null or not exists(select 1 from app_private.gateway_cleanup_members where job_id=j.id and resource_id=p_resource) then raise exception 'MEMBERSHIP_INCOMPLETE'; end if;
 perform app_private.gateway_check_verification(p_terminal,j.session_id,'terminal',p_resource);
 v:=app_private.gateway_check_verification(p_absence,j.session_id,'absence',p_resource);
 if v.terminal_id is distinct from p_terminal then raise exception 'EVIDENCE_MISMATCH'; end if;
 select * into old from app_private.gateway_removals where job_id=j.id and resource_id=p_resource and lease_epoch=p_lease;
 if found then
  if (old.operation_key,old.terminal_id,old.absence_id) is distinct from (p_operation,p_terminal,p_absence) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return p_resource;
 end if;
 insert into app_private.gateway_removals values(j.id,p_resource,p_lease,p_terminal,p_absence,p_operation);
 return p_resource;
end $$;
create function public.ss_gateway_settle_cleanup_v1(p_owner uuid,p_job uuid,p_lease bigint,p_operation uuid,p_membership uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.cleanup_jobs; s public.upload_sessions; u public.user_usage;
 old app_private.gateway_settlements; m record; result jsonb; begin
 -- Authenticate and acquire the shared locks before returning durable replay.
 select session_id into s.id from app_private.gateway_cleanup_snapshots where job_id=p_job and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 s:=app_private.gateway_lock_session(p_owner,s.id);
 select * into old from app_private.gateway_settlements where job_id=p_job;
 if found then
  if (old.operation_key,old.lease_epoch,old.membership_verification) is distinct from (p_operation,p_lease,p_membership) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return old.result;
 end if;
 if p_operation is null then raise exception 'INVALID_INPUT'; end if;
 j:=app_private.gateway_lock_cleanup(p_owner,p_job,p_lease);
 perform app_private.gateway_check_verification(p_membership,s.id,'membership',null);
 for m in select c.resource_id,r.absence_id,r.terminal_id from app_private.gateway_cleanup_members c
 left join app_private.gateway_removals r on r.job_id=c.job_id and r.resource_id=c.resource_id and r.lease_epoch=p_lease where c.job_id=j.id loop
  if m.absence_id is null then raise exception 'AUTHORITATIVE_ABSENCE_REQUIRED'; end if;
  perform app_private.gateway_check_verification(m.terminal_id,s.id,'terminal',m.resource_id);
  perform app_private.gateway_check_verification(m.absence_id,s.id,'absence',m.resource_id);
 end loop;
 select * into strict u from public.user_usage where owner_id=p_owner;
 if u.reserved_bytes::numeric<>(select coalesce(sum(held_bytes::numeric),0) from public.upload_sessions where owner_id=p_owner)
 or u.active_slots<>(select count(*) from public.upload_sessions where owner_id=p_owner and slot_held)
 or not s.slot_held or s.held_bytes>u.reserved_bytes or u.active_slots<1
 or not exists(select 1 from public.files where id=s.file_id and owner_id=p_owner and state='deleting' and coalesce(stored_bytes,0)=0)
 then raise exception 'ACCOUNTING_LIMIT'; end if;
 result:=jsonb_build_object('jobId',j.id,'state','settled','releasedBytes',s.held_bytes,'releasedSlots',1);
 insert into app_private.gateway_settlements values(j.id,p_owner,s.id,p_lease,p_operation,p_membership,s.held_bytes,1,result);
 update public.user_usage set reserved_bytes=reserved_bytes-s.held_bytes,active_slots=active_slots-1,revision=revision+1,updated_at=clock_timestamp() where owner_id=p_owner;
 insert into public.usage_events(owner_id,session_id,file_id,event_key,kind,reserved_delta,slot_delta)
 values(p_owner,s.id,s.file_id,'settle:'||s.id,'release',-s.held_bytes,-1);
 update app_private.gateway_requests set slot_held=false where session_id=s.id;
 update public.transfer_attempts set state='settled' where session_id=s.id;
 update public.file_blocks set state='deleted' where session_id=s.id;
 update public.files set state='deleted',revision=revision+1 where id=s.file_id;
 update public.upload_sessions set state='settled',held_bytes=0,slot_held=false,revision=revision+1 where id=s.id;
 update public.cleanup_jobs set state='done' where id=j.id;
 return result;
end $$;

-- 004 deliberately had no release path. Keep every identity field immutable;
-- allow only the exact once-only settlement to close occupied request slots.
alter table app_private.gateway_requests drop constraint gateway_requests_slot_held_check;
create function app_private.gateway_request_transition() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'GATEWAY_HISTORY_IMMUTABLE'; end if;
 if (to_jsonb(new)-'dispatched_at'-'slot_held') is distinct from (to_jsonb(old)-'dispatched_at'-'slot_held')
 then raise exception 'GATEWAY_HISTORY_IMMUTABLE'; end if;
 if new.slot_held is distinct from old.slot_held then
  if not old.slot_held or new.slot_held or new.dispatched_at is distinct from old.dispatched_at
   or not exists(select 1 from app_private.gateway_settlements where session_id=old.session_id and owner_id=old.owner_id)
   then raise exception 'EVIDENCE_REQUIRED'; end if;
 elsif old.dispatched_at is not null or new.dispatched_at is null then raise exception 'GATEWAY_HISTORY_IMMUTABLE'; end if;
 return new;
end $$;
drop trigger gateway_request_identity on app_private.gateway_requests;
create trigger gateway_request_identity before update or delete on app_private.gateway_requests
 for each row execute function app_private.gateway_request_transition();
-- Preserve 004's identity guards. Only the new private durable settlement may
-- authorize its existing blocked transitions. No caller-set GUC bypass.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('app_private.gateway_identity_guard()'::regprocedure);
 definition:=replace(definition,
 $a$raise exception 'EVIDENCE_REQUIRED';$a$,
 $b$if tg_table_name='upload_sessions' then
  if new.state<>'settled' or new.held_bytes<>0 or new.slot_held or not exists(
   select 1 from app_private.gateway_settlements where session_id=old.id and owner_id=old.owner_id
   and released_bytes=old.held_bytes and released_slots=1) then raise exception 'EVIDENCE_REQUIRED'; end if;
 elsif tg_table_name='transfer_attempts' then
  if new.state<>'settled' or not exists(select 1 from app_private.gateway_settlements where session_id=old.session_id and owner_id=old.owner_id)
  then raise exception 'EVIDENCE_REQUIRED'; end if;
 end if;$b$);
 execute definition;
end $$;
-- A late-discovered resource after a decision cannot authorize new writes. The
-- old registration RPC cannot register after cleanup: it requires the old epoch.
-- Explicit guard also rejects new allocation/enrollment mutations after fencing.
create function app_private.gateway_decision_insert_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare sid uuid; begin
 sid:=new.session_id;
 if exists(select 1 from app_private.gateway_cleanup_snapshots where session_id=sid)
 or exists(select 1 from app_private.gateway_preparations where session_id=sid) then raise exception 'DECISION_MEMBERSHIP_FROZEN'; end if;
 return new;
end $$;
create trigger gateway_resource_decision before insert on app_private.gateway_resources for each row execute function app_private.gateway_decision_insert_guard();
create trigger gateway_attempt_decision before insert on public.transfer_attempts for each row execute function app_private.gateway_decision_insert_guard();
create trigger gateway_request_decision before insert on app_private.gateway_requests for each row execute function app_private.gateway_decision_insert_guard();
-- Close only enrolled sessions; preserve the existing legacy grants/other sessions.
do $$ declare sig text; definition text; reference text; begin
 foreach sig in array array['public.ss_finalize_verified(uuid,jsonb,bigint,text,text)',
 'public.ss_reconcile_removed_attempt(uuid,boolean,boolean)','public.ss_settle_cleanup(uuid,boolean,boolean)'] loop
  definition:=pg_get_functiondef(sig::regprocedure);
  reference:=case when sig like '%ss_reconcile%' then
   '(select session_id from public.transfer_attempts where id=p_attempt)' else 'p_session' end;
  definition:=regexp_replace(definition,'begin',
   'begin if exists(select 1 from app_private.gateway_sessions where session_id='||reference||
   ') then raise exception ''GATEWAY_V1_REQUIRED''; end if;','i');
  execute definition;
 end loop;
end $$;

do $$ declare f record; begin
 for f in select oid::regprocedure sig,proname,pronamespace from pg_proc
 where (pronamespace='app_private'::regnamespace and proname like 'gateway_%')
 or (pronamespace='public'::regnamespace and proname in ('ss_gateway_prepare_finalization_v1','ss_gateway_begin_cleanup_v1',
 'ss_gateway_lease_cleanup_v1','ss_gateway_record_removal_v1','ss_gateway_settle_cleanup_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner',f.sig);
 end loop;
end $$;
grant usage on schema public to ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_gateway_prepare_finalization_v1(uuid,uuid,uuid,bigint,jsonb,uuid,uuid,bigint) to ss_gateway_finalizer;
grant execute on function public.ss_gateway_begin_cleanup_v1(uuid,uuid),public.ss_gateway_lease_cleanup_v1(uuid,uuid),
 public.ss_gateway_record_removal_v1(uuid,uuid,bigint,uuid,uuid,uuid,uuid),
 public.ss_gateway_settle_cleanup_v1(uuid,uuid,bigint,uuid,uuid) to ss_gateway_cleaner;
commit;
