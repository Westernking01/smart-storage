-- Phase 2.13A, LOCAL ONLY. No provider guarantees, release or settlement.
begin;
create role ss_gateway_observer nologin noinherit;
alter table public.transfer_attempts add constraint gateway_evidence_attempt_membership unique(id,session_id,owner_id);
-- No role membership is provisioned here. Trusted administrator ownership only.
create table app_private.gateway_resources (
  resource_id uuid primary key,
  request_id uuid not null references app_private.gateway_requests(request_id),
  owner_id uuid not null,
  session_id uuid not null,
  file_id uuid not null,
  attempt_id uuid,
  allocation_epoch bigint not null,
  parent_id uuid references app_private.gateway_resources(resource_id),
  kind text not null check(kind in ('object','manifest','temporary','part','version','creation_intent')),
  bucket text not null,
  object_path text not null check(octet_length(object_path) between 1 and 2048),
  scope jsonb not null check(jsonb_typeof(scope)='object' and octet_length(scope::text)<=4096),
  maximum_bytes bigint not null check(maximum_bytes between 0 and 9007199254740991),
  membership_generation bigint not null check(membership_generation>0),
  registered_at timestamptz not null default clock_timestamp(),
  unique(request_id,kind,object_path,scope),
  unique(resource_id,owner_id,session_id),
  foreign key(session_id,file_id,owner_id) references public.upload_sessions(id,file_id,owner_id),
  foreign key(attempt_id,session_id,owner_id) references public.transfer_attempts(id,session_id,owner_id)
);
create index gateway_resources_session on app_private.gateway_resources(session_id,membership_generation);
create table app_private.gateway_observation_receipts (
  receipt_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null default gen_random_uuid(),
  issuer text not null,
  operation_key uuid not null,
  resource_id uuid not null,
  owner_id uuid not null,
  session_id uuid not null,
  allocation_epoch bigint not null,
  decision_epoch bigint not null,
  evidence jsonb not null check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=16384),
  evidence_digest text not null,
  outcome text not null check(outcome in ('present','absent','ambiguous','inconclusive')),
  observed_bytes bigint check(observed_bytes>=0),
  observed_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  sufficiency text not null default 'provisional' check(sufficiency='provisional'),
  unique(issuer,operation_key),
  foreign key(resource_id,owner_id,session_id) references app_private.gateway_resources(resource_id,owner_id,session_id)
);
create index gateway_receipts_resource on app_private.gateway_observation_receipts(resource_id,received_at);
alter table app_private.gateway_resources enable row level security;
alter table app_private.gateway_observation_receipts enable row level security;
revoke all on app_private.gateway_resources,app_private.gateway_observation_receipts
  from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer;
create function app_private.gateway_evidence_immutable() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'EVIDENCE_HISTORY_IMMUTABLE'; end $$;
create trigger gateway_resources_immutable before update or delete on app_private.gateway_resources
for each row execute function app_private.gateway_evidence_immutable();
create trigger gateway_receipts_immutable before update or delete on app_private.gateway_observation_receipts
for each row execute function app_private.gateway_evidence_immutable();

-- Scope contains namespace, uploadId, version and generation (explicit JSON null
-- means unavailable). It is historical identity, never a completeness assertion.
-- Manifest membership is associated with the claim, not a fabricated attempt.
create function public.ss_gateway_register_resource_v1(
 p_owner uuid,p_request uuid,p_resource uuid,p_epoch bigint,p_kind text,
 p_path text,p_scope jsonb,p_maximum_bytes bigint,p_parent uuid default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare r app_private.gateway_requests; a public.transfer_attempts;
 s public.upload_sessions; old app_private.gateway_resources; parent app_private.gateway_resources; g bigint;
begin
 select * into r from app_private.gateway_requests where request_id=p_request and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 a:=app_private.gateway_lock_attempt(p_owner,r.attempt_id);
 select * into strict s from public.upload_sessions where id=r.session_id;
 if p_epoch is distinct from s.epoch or p_epoch is distinct from r.epoch then raise exception 'STALE_EPOCH'; end if;
 if p_resource is null or p_kind is null or p_path is null or p_maximum_bytes is null
 or p_scope is null or jsonb_typeof(p_scope)<>'object'
 or not (p_scope ?& array['namespace','uploadId','version','generation'])
 or coalesce(length(p_scope->>'namespace'),0)=0 then raise exception 'INVALID_SCOPE'; end if;
 if p_kind='object' and (p_path<>r.object_path or p_parent is not null) then raise exception 'RESOURCE_MISMATCH'; end if;
 if p_kind='manifest' and (p_path<>s.manifest_path or p_parent is not null) then raise exception 'RESOURCE_MISMATCH'; end if;
 if p_kind not in ('object','manifest') then
   select * into parent from app_private.gateway_resources where resource_id=p_parent;
   if not found or parent.request_id<>r.request_id or parent.owner_id<>p_owner
      or parent.scope->>'namespace' is distinct from p_scope->>'namespace' then raise exception 'RESOURCE_MISMATCH'; end if;
 end if;
 select * into old from app_private.gateway_resources where resource_id=p_resource;
 if found then
   if (old.request_id,old.kind,old.object_path,old.scope,old.maximum_bytes,old.parent_id)
    is distinct from (p_request,p_kind,p_path,p_scope,p_maximum_bytes,p_parent) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return old.resource_id;
 end if;
 select coalesce(max(membership_generation),0)+1 into g from app_private.gateway_resources where session_id=s.id;
 insert into app_private.gateway_resources(resource_id,request_id,owner_id,session_id,file_id,attempt_id,
 allocation_epoch,parent_id,kind,bucket,object_path,scope,maximum_bytes,membership_generation)
 values(p_resource,r.request_id,p_owner,s.id,s.file_id,case when p_kind='object' then a.id else null end,r.epoch,p_parent,p_kind,r.bucket,p_path,p_scope,p_maximum_bytes,g);
 return p_resource;
end $$;

-- Observer role is the authenticated producer. Caller cannot choose an issuer.
-- Historical observations survive cancellation; stale decisions never promote.
-- There is deliberately no authoritative/terminal certification in this phase.
create function public.ss_gateway_record_receipt_v1(
 p_owner uuid,p_resource uuid,p_operation uuid,p_epoch bigint,p_evidence jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare r app_private.gateway_resources; a public.transfer_attempts;
 old app_private.gateway_observation_receipts; principal text;
 result uuid; outcome text; size bigint; observed timestamptz;
begin
 principal:=coalesce(nullif(current_setting('role'),'none'),session_user);
 select * into r from app_private.gateway_resources where resource_id=p_resource and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 a:=app_private.gateway_lock_attempt(p_owner,(select attempt_id from app_private.gateway_requests where request_id=r.request_id));
 if p_epoch is distinct from r.allocation_epoch then raise exception 'STALE_EPOCH'; end if;
 if p_operation is null or p_evidence is null or jsonb_typeof(p_evidence)<>'object'
 or not (p_evidence ?& array['scope','kind','outcome','observedAt','observedBytes','provenance','verifierRevision'])
 or p_evidence->'scope' is distinct from r.scope
 or coalesce(p_evidence->>'kind','') not in ('inspection','absence','delete_response','listing','timeout')
 or jsonb_typeof(p_evidence->'provenance') is distinct from 'object'
 or coalesce(length(p_evidence->>'verifierRevision'),0)=0 then raise exception 'EVIDENCE_MISMATCH'; end if;
 outcome:=p_evidence->>'outcome';
 if outcome is null or outcome not in ('present','absent','ambiguous','inconclusive') then raise exception 'EVIDENCE_MISMATCH'; end if;
 if outcome='absent' and p_evidence->>'kind'<>'absence' then raise exception 'ABSENCE_PROTOCOL_REQUIRED'; end if;
 size:=(p_evidence->>'observedBytes')::bigint;
 observed:=(p_evidence->>'observedAt')::timestamptz;
 if observed is null or observed>clock_timestamp() or (outcome='present' and size is null)
 or (outcome='absent' and size is not null) then raise exception 'EVIDENCE_MISMATCH'; end if;
 select * into old from app_private.gateway_observation_receipts where issuer=principal and operation_key=p_operation;
 if found then
   if (old.resource_id,old.allocation_epoch,old.evidence) is distinct from (p_resource,p_epoch,p_evidence) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return old.receipt_id;
 end if;
 insert into app_private.gateway_observation_receipts(issuer,operation_key,resource_id,owner_id,session_id,
 allocation_epoch,decision_epoch,evidence,evidence_digest,outcome,observed_bytes,observed_at)
 values(principal,p_operation,r.resource_id,p_owner,r.session_id,p_epoch,
 (select epoch from public.upload_sessions where id=r.session_id),p_evidence,
 encode(sha256(convert_to(p_evidence::text,'UTF8')),'hex'),outcome,size,observed) returning receipt_id into result;
 return result;
end $$;
revoke all on function app_private.gateway_evidence_immutable() from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer;
revoke all on function public.ss_gateway_register_resource_v1(uuid,uuid,uuid,bigint,text,text,jsonb,bigint,uuid),
 public.ss_gateway_record_receipt_v1(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer;
grant usage on schema public to ss_gateway_observer;
grant execute on function public.ss_gateway_register_resource_v1(uuid,uuid,uuid,bigint,text,text,jsonb,bigint,uuid) to ss_gateway_executor;
grant execute on function public.ss_gateway_record_receipt_v1(uuid,uuid,uuid,bigint,jsonb) to ss_gateway_observer;
commit;
