-- Phase 2.14A LOCAL ONLY. No provider protocol or verifier is provisioned.
begin;
alter table app_private.gateway_requests alter column attempt_id drop not null;
alter table app_private.gateway_requests alter column block_id drop not null;
alter table app_private.gateway_requests add column target_resource uuid references app_private.gateway_resources;
alter table app_private.gateway_requests add constraint gateway_writer_target check
 ((attempt_id is not null and block_id is not null and target_resource is null) or
 (attempt_id is null and block_id is null and target_resource is not null));
create table app_private.gateway_stream_completions (
 request_id uuid primary key references app_private.gateway_requests,
 operation_key uuid not null unique,
 resource_id uuid not null references app_private.gateway_resources,
 present_id uuid not null references app_private.gateway_verifications,
 terminal_id uuid not null references app_private.gateway_verifications,
 completed_at timestamptz not null default clock_timestamp()
);
-- Gateway request completion is only a local fact. It is independent of
-- committed evidence, provider ambiguity, writer termination and occupancy.
create table app_private.gateway_stream_outcomes (
 operation_key uuid primary key,
 request_id uuid not null references app_private.gateway_requests,
 outcome text not null check(outcome in ('request_completed','ambiguous')),
 recorded_at timestamptz not null default clock_timestamp()
);
create function public.ss_gateway_record_stream_outcome_v1(p_owner uuid,p_request uuid,
 p_executor uuid,p_operation uuid,p_outcome text) returns uuid
language plpgsql security definer set search_path='' as $$
declare q app_private.gateway_requests; old app_private.gateway_stream_outcomes; begin
 select * into q from app_private.gateway_requests where request_id=p_request and owner_id=p_owner;
 if not found or q.executor_id is distinct from p_executor then raise exception 'FORBIDDEN'; end if;
 perform app_private.gateway_lock_session(p_owner,q.session_id);
 if p_operation is null or p_outcome is null or p_outcome not in ('request_completed','ambiguous') then raise exception 'INVALID_INPUT'; end if;
 select * into old from app_private.gateway_stream_outcomes where operation_key=p_operation;
 if found then
  if (old.request_id,old.outcome) is distinct from (p_request,p_outcome) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return p_operation;
 end if;
 -- Historical executor reports may survive fencing, but cannot authorize I/O,
 -- change a durable committed result, or free any capacity.
 insert into app_private.gateway_stream_outcomes(operation_key,request_id,outcome) values(p_operation,p_request,p_outcome);
 return p_operation;
end $$;
-- Occupancy is not a writer identity. Closing a stream must not invalidate its
-- own proof; dispatch and every immutable grant field remain in the digest.
create or replace function app_private.gateway_writer_digest(p_session uuid) returns text
language sql stable set search_path='' as $$
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r)-'slot_held' order by r.request_id),'[]'::jsonb)::text,'UTF8')),'hex')
 from app_private.gateway_requests r where r.session_id=p_session
$$;
create function public.ss_gateway_complete_stream_v1(p_owner uuid,p_request uuid,p_epoch bigint,
 p_operation uuid,p_resource uuid,p_present uuid,p_terminal uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare q app_private.gateway_requests; s public.upload_sessions; r app_private.gateway_resources;
 v app_private.gateway_verifications; old app_private.gateway_stream_completions; begin
 select * into q from app_private.gateway_requests where request_id=p_request and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 s:=app_private.gateway_lock_session(p_owner,q.session_id);
 if p_epoch is distinct from s.epoch or p_epoch is distinct from q.epoch then raise exception 'STALE_EPOCH'; end if;
 select * into old from app_private.gateway_stream_completions where request_id=p_request;
 if found then
  if (old.operation_key,old.resource_id,old.present_id,old.terminal_id) is distinct from
   (p_operation,p_resource,p_present,p_terminal) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return p_request;
 end if;
 select * into r from app_private.gateway_resources where resource_id=p_resource and owner_id=p_owner and session_id=s.id;
 if not found or q.dispatched_at is null or p_operation is null or
  (q.target_resource is not null and q.target_resource<>r.resource_id) or
  (q.attempt_id is not null and (r.request_id<>q.request_id or r.attempt_id is distinct from q.attempt_id or r.kind<>'object'))
 then raise exception 'RESOURCE_MISMATCH'; end if;
 perform app_private.gateway_check_verification(p_terminal,s.id,'terminal',r.resource_id);
 v:=app_private.gateway_check_verification(p_present,s.id,case when r.kind='manifest' then 'manifest' else 'present' end,r.resource_id);
 if v.terminal_id is distinct from p_terminal or v.accepted_bytes is distinct from q.declared_bytes
 then raise exception 'EVIDENCE_MISMATCH'; end if;
 if q.attempt_id is not null and v.content_sha256 is distinct from
  (select encoded_sha256 from public.file_blocks where id=q.block_id) then raise exception 'SIZE_OR_HASH_MISMATCH'; end if;
 insert into app_private.gateway_stream_completions(request_id,operation_key,resource_id,present_id,terminal_id)
 values(p_request,p_operation,p_resource,p_present,p_terminal);
 update app_private.gateway_requests set slot_held=false where request_id=p_request;
 -- No reserved-byte, stored-byte, upload-session slot or usage-event change.
 return p_request;
end $$;
create table app_private.gateway_discoveries (
 discovery_id uuid primary key,
 owner_id uuid not null,
 session_id uuid not null,
 request_id uuid not null references app_private.gateway_requests,
 decision_epoch bigint not null,
 resource_id uuid not null unique,
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
 foreign key(session_id,owner_id) references public.upload_sessions(id,owner_id)
);
-- Administrator-only reviewed imports, just like protocol/verifications in 006.
-- No runtime RPC can assert complete provider enumeration or clear an incident.
create table app_private.gateway_discovery_closures (
 closure_id uuid primary key,
 session_id uuid not null references app_private.gateway_sessions,
 decision_epoch bigint not null,
 discovery_digest text not null,
 membership_id uuid not null references app_private.gateway_verifications,
 evidence_reference text not null check(length(evidence_reference) between 1 and 2048)
);
create table app_private.gateway_reconciliations (
 closure_id uuid primary key references app_private.gateway_discovery_closures,
 session_id uuid not null references app_private.gateway_sessions,
 membership_digest text not null,
 reconciled_at timestamptz not null default clock_timestamp()
);
create function app_private.gateway_discovery_digest(p_session uuid) returns text
language sql stable set search_path='' as $$
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(d) order by discovery_id),'[]'::jsonb)::text,'UTF8')),'hex')
 from app_private.gateway_discoveries d where session_id=p_session
$$;
create function public.ss_gateway_discover_resource_v1(p_owner uuid,p_request uuid,p_epoch bigint,
 p_discovery uuid,p_resource uuid,p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare q app_private.gateway_requests; s public.upload_sessions; old app_private.gateway_discoveries;
 parent app_private.gateway_resources; g bigint; begin
 select * into q from app_private.gateway_requests where request_id=p_request and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 s:=app_private.gateway_lock_session(p_owner,q.session_id);
 if p_epoch is distinct from s.epoch then raise exception 'STALE_EPOCH'; end if;
 if p_discovery is null or p_resource is null or jsonb_typeof(p_payload) is distinct from 'object'
 or not(p_payload ?& array['kind','path','scope','maximumBytes','parent','unexpected','complete'])
 or jsonb_typeof(p_payload->'unexpected') is distinct from 'boolean'
 or jsonb_typeof(p_payload->'complete') is distinct from 'boolean'
 or not(p_payload->'scope' ?& array['namespace','uploadId','version','generation'])
 or coalesce(length(p_payload->'scope'->>'namespace'),0)=0
 or p_payload->>'kind' not in ('object','manifest','temporary','part','version','creation_intent')
 or coalesce(length(p_payload->>'path'),0)=0
 or (p_payload->>'maximumBytes')::bigint is null then raise exception 'INVALID_SCOPE'; end if;
 select * into old from app_private.gateway_discoveries where discovery_id=p_discovery;
 if found then
  if (old.owner_id,old.request_id,old.decision_epoch,old.resource_id,old.payload) is distinct from
   (p_owner,p_request,p_epoch,p_resource,p_payload) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return p_resource;
 end if;
 if p_payload->>'parent' is not null then
  select * into parent from app_private.gateway_resources where resource_id=(p_payload->>'parent')::uuid
   and session_id=s.id and owner_id=p_owner;
  if not found or parent.scope->>'namespace' is distinct from p_payload->'scope'->>'namespace'
  then raise exception 'RESOURCE_MISMATCH'; end if;
 end if;
 -- Immutable anchor is the original claim, not caller-supplied account/file or
 -- allocation epoch. Unknown identities are preserved and never grant dispatch.
 insert into app_private.gateway_discoveries values(p_discovery,p_owner,s.id,p_request,p_epoch,p_resource,p_payload);
 select coalesce(max(membership_generation),0)+1 into g from app_private.gateway_resources where session_id=s.id;
 insert into app_private.gateway_resources(resource_id,request_id,owner_id,session_id,file_id,allocation_epoch,
 parent_id,kind,bucket,object_path,scope,maximum_bytes,membership_generation)
 values(p_resource,q.request_id,p_owner,s.id,s.file_id,q.epoch,(p_payload->>'parent')::uuid,
 p_payload->>'kind',q.bucket,p_payload->>'path',p_payload->'scope',(p_payload->>'maximumBytes')::bigint,g);
 if exists(select 1 from app_private.gateway_settlements where session_id=s.id)
 or (p_payload->>'unexpected')::boolean then
  insert into app_private.gateway_invalidations values(gen_random_uuid(),s.id,'Discovered resource requires investigation: '||p_discovery,default);
 end if;
 return p_resource;
end $$;
-- Permit append-only discovered membership even after a frozen decision. No
-- caller-controlled flag bypass: the exact discovery must already be durable.
create or replace function app_private.gateway_decision_insert_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='gateway_resources' then
  if exists(select 1 from app_private.gateway_discoveries d where d.resource_id=new.resource_id
   and d.session_id=new.session_id and d.owner_id=new.owner_id and d.request_id=new.request_id
   and d.payload->>'path'=new.object_path and d.payload->'scope'=new.scope) then return new; end if;
 end if;
 if exists(select 1 from app_private.gateway_cleanup_snapshots where session_id=new.session_id)
 or exists(select 1 from app_private.gateway_preparations where session_id=new.session_id)
 then raise exception 'DECISION_MEMBERSHIP_FROZEN'; end if;
 return new;
end $$;
create function public.ss_gateway_reconcile_discoveries_v1(p_owner uuid,p_session uuid,p_epoch bigint,p_closure uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; c app_private.gateway_discovery_closures; digest text; begin
 s:=app_private.gateway_lock_session(p_owner,p_session);
 if p_epoch is distinct from s.epoch then raise exception 'STALE_EPOCH'; end if;
 select * into c from app_private.gateway_discovery_closures where closure_id=p_closure and session_id=s.id;
 if not found then raise exception 'DISCOVERY_INCOMPLETE'; end if;
 if c.decision_epoch<>s.epoch or c.discovery_digest<>app_private.gateway_discovery_digest(s.id)
 then raise exception 'DISCOVERY_INCOMPLETE'; end if;
 perform app_private.gateway_check_verification(c.membership_id,s.id,'membership',null);
 digest:=app_private.gateway_membership_digest(s.id);
 insert into app_private.gateway_reconciliations(closure_id,session_id,membership_digest)
 values(c.closure_id,s.id,digest) on conflict do nothing;
 return c.closure_id;
end $$;
-- A reconciliation supersedes the snapshot's membership for checks, preserving
-- the original snapshot and removal history. Every new member needs new proofs.
do $$ declare d text; begin
 d:=pg_get_functiondef('app_private.gateway_lock_cleanup(uuid,uuid,bigint)'::regprocedure);
 d:=replace(d,'if snap.membership_digest<>app_private.gateway_membership_digest(s.id)',
 'if not exists(select 1 from app_private.gateway_reconciliations x join app_private.gateway_discovery_closures c using(closure_id) where x.session_id=s.id and c.decision_epoch=s.epoch and c.discovery_digest=app_private.gateway_discovery_digest(s.id) and x.membership_digest=app_private.gateway_membership_digest(s.id)) and snap.membership_digest<>app_private.gateway_membership_digest(s.id)');
 -- Extend the checked enumeration only after a sealed complete discovery.
 d:=replace(d,'perform app_private.gateway_check_membership(s.id);',
 'perform app_private.gateway_check_membership(s.id); insert into app_private.gateway_cleanup_members select j.id,resource_id from app_private.gateway_resources where session_id=s.id on conflict do nothing;');
 execute d;
 d:=pg_get_functiondef('app_private.gateway_check_membership(uuid)'::regprocedure);
 d:=replace(d,'-- An unresolved creation intent',
 'if exists(select 1 from app_private.gateway_discoveries where session_id=s.id) and not exists(select 1 from app_private.gateway_reconciliations x join app_private.gateway_discovery_closures c using(closure_id) where x.session_id=s.id and c.decision_epoch=s.epoch and c.discovery_digest=app_private.gateway_discovery_digest(s.id) and x.membership_digest=app_private.gateway_membership_digest(s.id)) then raise exception ''DISCOVERY_INCOMPLETE''; end if; -- An unresolved creation intent');
 execute d;
end $$;
-- Preserve all existing transition guards, adding only durable completion as a
-- second authorized reason to close stream occupancy.
do $$ declare d text; begin
 d:=pg_get_functiondef('app_private.gateway_request_transition()'::regprocedure);
 d:=replace(d,
 'or not exists(select 1 from app_private.gateway_settlements where session_id=old.session_id and owner_id=old.owner_id)',
 'or not (exists(select 1 from app_private.gateway_settlements where session_id=old.session_id and owner_id=old.owner_id) or exists(select 1 from app_private.gateway_stream_completions where request_id=old.request_id))');
 execute d;
end $$;
create function public.ss_gateway_claim_resource_v1(p_owner uuid,p_resource uuid,p_request uuid,
 p_epoch bigint,p_bytes bigint,p_executor uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare r app_private.gateway_resources; s public.upload_sessions; c app_private.gateway_accounts;
 q app_private.gateway_requests; digest text; begin
 select * into r from app_private.gateway_resources where resource_id=p_resource and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 s:=app_private.gateway_lock_session(p_owner,r.session_id);
 if p_epoch is distinct from s.epoch or r.allocation_epoch<>s.epoch then raise exception 'STALE_EPOCH'; end if;
 if p_request is null or p_executor is null or p_bytes is null or p_bytes<0 or p_bytes>8388608
 or r.kind='object' or p_bytes>r.maximum_bytes or (r.kind='manifest' and p_bytes>131072) then raise exception 'INVALID_INPUT'; end if;
 digest:=encode(sha256(convert_to(jsonb_build_array(p_owner,p_resource,p_epoch,p_bytes,p_executor)::text,'UTF8')),'hex');
 select * into q from app_private.gateway_requests where request_id=p_request;
 if found then
  if q.owner_id<>p_owner or q.input_digest<>digest then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  raise exception 'ATTEMPT_AMBIGUOUS';
 end if;
 if s.state<>'uploading' or not s.slot_held or s.lease_expires_at<=clock_timestamp()
 or exists(select 1 from app_private.gateway_invalidations where session_id=s.id)
 then raise exception 'SESSION_BLOCKED'; end if;
 -- Includes overlapping staging/final resources and unresolved creation intents.
 if (select coalesce(sum(maximum_bytes::numeric),0) from app_private.gateway_resources where session_id=s.id)>s.held_bytes
 then raise exception 'ACCOUNTING_LIMIT'; end if;
 select * into c from app_private.gateway_accounts where owner_id=p_owner for update;
 if not found or (select count(*) from app_private.gateway_requests where owner_id=p_owner and slot_held)>=c.max_active_streams
 or exists(select 1 from app_private.gateway_requests where session_id=s.id and slot_held) then raise exception 'CAPACITY_EXCEEDED'; end if;
 insert into app_private.gateway_requests(request_id,session_id,file_id,owner_id,input_digest,descriptor_digest,epoch,
 declared_bytes,bucket,object_path,executor_id,target_resource)
 values(p_request,s.id,s.file_id,p_owner,digest,app_private.gateway_membership_digest(s.id),s.epoch,p_bytes,r.bucket,r.object_path,p_executor,r.resource_id);
 return p_request;
end $$;
-- A genuine manifest/temporary writer has no fabricated block attempt. Reuse
-- the same dispatch grant, executor binding and account/session lock order.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.ss_gateway_dispatch_v1(uuid,uuid,uuid,bigint)'::regprocedure);
 d:=replace(d,'a := app_private.gateway_lock_attempt(p_owner,r.attempt_id);',
 'if r.attempt_id is not null then a := app_private.gateway_lock_attempt(p_owner,r.attempt_id); else perform app_private.gateway_lock_session(p_owner,r.session_id); end if;');
 d:=replace(d,'where id=a.session_id;','where id=r.session_id;');
 d:=replace(d,'or a.expires_at<=t','or (r.attempt_id is not null and a.expires_at<=t)');
 d:=replace(d,'or a.state<>''in_flight''','or (r.attempt_id is not null and a.state<>''in_flight'')');
 d:=replace(d,'update app_private.gateway_requests set dispatched_at=t',
 'if exists(select 1 from app_private.gateway_invalidations where session_id=s.id) then raise exception ''EVIDENCE_QUARANTINED''; end if; update app_private.gateway_requests set dispatched_at=t');
 execute d;
 d:=pg_get_functiondef('public.ss_gateway_record_receipt_v1(uuid,uuid,uuid,bigint,jsonb)'::regprocedure);
 d:=replace(d,'a:=app_private.gateway_lock_attempt(p_owner,(select attempt_id from app_private.gateway_requests where request_id=r.request_id));',
 'perform app_private.gateway_lock_session(p_owner,r.session_id);');
 execute d;
end $$;
-- Keep legacy claims usable after conclusively closed earlier block streams.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.ss_gateway_claim_v1(uuid,uuid,uuid,bigint,uuid)'::regprocedure);
 d:=replace(d,$old$and (a0.state<>'authorized' or a0.attempted_bytes<>0 or a0.observed_bytes is not null)$old$,
 $new$and (a0.state<>'authorized' or a0.attempted_bytes<>0 or a0.observed_bytes is not null) and not exists(select 1 from app_private.gateway_requests q0 join app_private.gateway_stream_completions c0 using(request_id) where q0.attempt_id=a0.id)$new$);
 d:=replace(d,'if (select coalesce(sum(authorized_max_bytes::numeric),0)+131072',
 'if (select coalesce(sum(maximum_bytes::numeric),0) from app_private.gateway_resources where session_id=s.id and kind not in (''object'',''manifest'')) + (select coalesce(sum(authorized_max_bytes::numeric),0)+131072');
 d:=replace(d,'t := clock_timestamp();',
 'if exists(select 1 from app_private.gateway_discoveries where session_id=s.id) or exists(select 1 from app_private.gateway_invalidations where session_id=s.id) then raise exception ''EVIDENCE_QUARANTINED''; end if; t := clock_timestamp();');
 execute d;
end $$;
do $$ declare t text; begin
 foreach t in array array['gateway_stream_outcomes','gateway_stream_completions','gateway_discoveries','gateway_discovery_closures','gateway_reconciliations'] loop
  execute format('alter table app_private.%I enable row level security',t);
  execute format('revoke all on app_private.%I from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner',t);
  execute format('create trigger immutable before update or delete on app_private.%I for each row execute function app_private.gateway_evidence_immutable()',t);
 end loop;
end $$;
revoke all on function app_private.gateway_discovery_digest(uuid) from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
revoke all on function public.ss_gateway_record_stream_outcome_v1(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_gateway_record_stream_outcome_v1(uuid,uuid,uuid,uuid,text) to ss_gateway_executor;
revoke all on function public.ss_gateway_complete_stream_v1(uuid,uuid,bigint,uuid,uuid,uuid,uuid),
 public.ss_gateway_claim_resource_v1(uuid,uuid,uuid,bigint,bigint,uuid),
 public.ss_gateway_discover_resource_v1(uuid,uuid,bigint,uuid,uuid,jsonb),
 public.ss_gateway_reconcile_discoveries_v1(uuid,uuid,bigint,uuid)
 from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_gateway_complete_stream_v1(uuid,uuid,bigint,uuid,uuid,uuid,uuid),
 public.ss_gateway_claim_resource_v1(uuid,uuid,uuid,bigint,bigint,uuid) to ss_gateway_executor;
grant execute on function public.ss_gateway_discover_resource_v1(uuid,uuid,bigint,uuid,uuid,jsonb),
 public.ss_gateway_reconcile_discoveries_v1(uuid,uuid,bigint,uuid) to ss_gateway_observer;
-- No provider-writing grant may escape without registered bounded membership.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.ss_gateway_dispatch_v1(uuid,uuid,uuid,bigint)'::regprocedure);
 d:=replace(d,'update app_private.gateway_requests set dispatched_at=t',
 $guard$if r.attempt_id is not null and not exists(select 1 from app_private.gateway_resources x where x.request_id=r.request_id and x.attempt_id=r.attempt_id and x.kind='object' and x.object_path=r.object_path and x.maximum_bytes>=r.declared_bytes) then raise exception 'MEMBERSHIP_INCOMPLETE'; end if;
 if (select coalesce(sum(maximum_bytes::numeric),0) from app_private.gateway_resources where session_id=s.id)>s.held_bytes then raise exception 'ACCOUNTING_LIMIT'; end if;
 if r.target_resource is not null and r.descriptor_digest<>app_private.gateway_membership_digest(s.id) then raise exception 'MEMBERSHIP_CHANGED'; end if;
 update app_private.gateway_requests set dispatched_at=t$guard$);
 execute d;
end $$;
-- Trusted observations cannot promote an unclaimed manifest/temporary writer.
do $$ declare d text; begin
 d:=pg_get_functiondef('app_private.gateway_check_verification(uuid,uuid,text,uuid)'::regprocedure);
 d:=replace(d,'if p_kind=''terminal'' then return v; end if;',
 $guard$if p_kind='terminal' then return v; end if;
 if p_kind in ('present','manifest') and not exists(select 1 from app_private.gateway_requests q where q.session_id=s.id and q.dispatched_at is not null and
 ((r.kind='object' and q.request_id=r.request_id and q.attempt_id=r.attempt_id) or (r.kind<>'object' and q.target_resource=r.resource_id))) then raise exception 'WRITER_CLAIM_REQUIRED'; end if;
 if p_kind in ('present','manifest') and not exists(select 1 from app_private.gateway_requests q where q.session_id=s.id and q.dispatched_at is not null and q.declared_bytes=v.accepted_bytes and
 ((r.kind='object' and q.request_id=r.request_id and q.attempt_id=r.attempt_id) or (r.kind<>'object' and q.target_resource=r.resource_id))) then raise exception 'SIZE_OR_HASH_MISMATCH'; end if;$guard$);
 execute d;
end $$;
do $$ declare d text; begin
 d:=pg_get_functiondef('public.ss_gateway_settle_cleanup_v1(uuid,uuid,bigint,uuid,uuid)'::regprocedure);
 d:=replace(d,'update app_private.gateway_requests set slot_held=false where session_id=s.id;',
 'update app_private.gateway_requests set slot_held=false where session_id=s.id and slot_held;');
 execute d;
end $$;
commit;
