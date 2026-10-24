-- Phase 2.14H.1: additive local-only provisional write observations.
-- Trusted migration owner only. No role creation, certificate or accounting path.
begin;
create table app_private.gateway_write_observations (
 receipt_id uuid primary key default gen_random_uuid(),
 operation_key uuid not null unique,
 request_id uuid not null references app_private.gateway_requests,
 resource_id uuid not null references app_private.gateway_resources,
 owner_id uuid not null,
 epoch bigint not null,
 observation jsonb not null check(jsonb_typeof(observation)='object' and octet_length(observation::text)<=16384),
 sufficiency text not null default 'provisional' check(sufficiency='provisional'),
 received_at timestamptz not null default clock_timestamp()
);
alter table app_private.gateway_write_observations enable row level security;
revoke all on app_private.gateway_write_observations from public,anon,authenticated,service_role,
 ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
create trigger gateway_write_observations_immutable before update or delete on app_private.gateway_write_observations
 for each row execute function app_private.gateway_evidence_immutable();

-- SECURITY DEFINER is required: runtime executor has no private table access.
-- Executor is a trusted backend principal, just as for claim/dispatch. UUID
-- assertions alone never authenticate a browser. No runtime membership is added.
-- v1 deliberately supports the block single-create WriteIntent, not generalized
-- resource writers whose Phase 2.14G intent currently requires an attempt ID.
-- Permit mapping: decisionId=request, writerId=executor, reservationId=session,
-- exposureId=resource; maximumEncodedBytes=declared, reservedExposureBytes=maximum.
create function public.ss_gateway_record_write_observation_v1(
 p_owner uuid,p_request uuid,p_resource uuid,p_executor uuid,p_epoch bigint,
 p_operation uuid,p_observation jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare q app_private.gateway_requests; r app_private.gateway_resources;
 a public.transfer_attempts; b public.file_blocks; s public.upload_sessions;
 old app_private.gateway_write_observations; result uuid; k text; v jsonb;
 n numeric; started numeric; finished numeric; input_count numeric; forwarded numeric;
begin
 select * into q from app_private.gateway_requests where request_id=p_request and owner_id=p_owner;
 if not found or q.executor_id is distinct from p_executor or q.attempt_id is null then raise exception 'FORBIDDEN'; end if;
 a:=app_private.gateway_lock_attempt(p_owner,q.attempt_id);
 -- Re-read after acquiring common locks: stream completion can change slot_held
 -- while this invocation waits. Never authorize against the pre-lock snapshot.
 select * into strict q from app_private.gateway_requests where request_id=p_request for update;
 select * into strict s from public.upload_sessions where id=q.session_id;
 select * into strict b from public.file_blocks where id=q.block_id;
 select * into r from app_private.gateway_resources where resource_id=p_resource;
 if not found or (r.request_id,r.owner_id,r.session_id,r.file_id,r.attempt_id,r.kind,r.bucket,r.object_path,r.allocation_epoch)
 is distinct from (q.request_id,q.owner_id,q.session_id,q.file_id,q.attempt_id,'object'::text,q.bucket,q.object_path,q.epoch)
 then raise exception 'RESOURCE_MISMATCH'; end if;
 if p_epoch is distinct from q.epoch or p_epoch is distinct from s.epoch then raise exception 'STALE_EPOCH'; end if;
 if q.dispatched_at is null or not q.slot_held or not s.slot_held or s.state<>'uploading'
 or exists(select 1 from app_private.gateway_invalidations where session_id=s.id)
 then raise exception 'SESSION_BLOCKED'; end if;
 if r.maximum_bytes<q.declared_bytes or
 (select coalesce(sum(maximum_bytes::numeric),0) from app_private.gateway_resources where session_id=s.id)>s.held_bytes
 then raise exception 'ACCOUNTING_LIMIT'; end if;
 -- No expiry test here: a dispatched writer may time out after its lease.
 -- Current fencing and lifecycle still fail closed; holds remain on rejection.
 if p_operation is null or p_observation is null or jsonb_typeof(p_observation)<>'object'
 or octet_length(p_observation::text)>16384 then raise exception 'INVALID_OBSERVATION'; end if;
 if p_observation->'intent' is distinct from jsonb_build_object(
 'ownerId',q.owner_id,'requestId',q.request_id,'resourceId',r.resource_id,'executorId',q.executor_id,
 'dispatchGeneration',q.dispatch_generation,'epoch',q.epoch,'bucket',q.bucket,'path',q.object_path,
 'sessionId',q.session_id,'fileId',q.file_id,'attemptId',q.attempt_id,'declaredBytes',q.declared_bytes,
 'expectedSha256',b.encoded_sha256,'operation','single-object-create')
 or p_observation->>'decisionId' is distinct from q.request_id::text
 or p_observation->>'writerId' is distinct from q.executor_id::text
 or p_observation->>'reservationId' is distinct from q.session_id::text
 or p_observation->>'exposureId' is distinct from r.resource_id::text
 or p_observation->'maximumEncodedBytes' is distinct from to_jsonb(q.declared_bytes)
 or p_observation->'reservedExposureBytes' is distinct from to_jsonb(r.maximum_bytes)
 then raise exception 'IDENTITY_MISMATCH'; end if;
 if p_observation->'classification' is distinct from '"provisional"'::jsonb
 or p_observation->'certified' is distinct from 'false'::jsonb
 or p_observation->'retainHolds' is distinct from 'true'::jsonb
 or p_observation->'futureProviderEffectsPossible' is distinct from 'true'::jsonb
 or p_observation->'evidencePersistence' is distinct from '"pending-durable-ack"'::jsonb
 or jsonb_typeof(p_observation->'reason') is distinct from 'string'
 or length(p_observation->>'reason') not between 1 and 160
 or jsonb_typeof(p_observation->'digestComplete') is distinct from 'boolean'
 then raise exception 'INVALID_OBSERVATION'; end if;
 foreach k in array array['startedAt','finishedAt','inputBytes','forwardedBytes'] loop
  v:=p_observation->k;
  if jsonb_typeof(v) is distinct from 'number' then raise exception 'INVALID_OBSERVATION'; end if;
  n:=v::text::numeric;
  if n<0 or n>9007199254740991 or trunc(n)<>n then raise exception 'INVALID_OBSERVATION'; end if;
 end loop;
 started:=(p_observation->>'startedAt')::numeric; finished:=(p_observation->>'finishedAt')::numeric;
 input_count:=(p_observation->>'inputBytes')::numeric; forwarded:=(p_observation->>'forwardedBytes')::numeric;
 if finished<started or forwarded>input_count or forwarded>q.declared_bytes then raise exception 'INVALID_OBSERVATION'; end if;
 if not (p_observation ? 'sha256') or (p_observation->'sha256'<>'null'::jsonb and
 (jsonb_typeof(p_observation->'sha256')<>'string' or p_observation->>'sha256' !~ '^[a-f0-9]{64}$'))
 or (p_observation->>'digestComplete')::boolean and (forwarded<>q.declared_bytes or p_observation->'sha256'='null'::jsonb)
 then raise exception 'INVALID_OBSERVATION'; end if;
 k:=p_observation->>'state';
 if k is null or k not in ('dispatch-intent','response-observed','ambiguous') or not(p_observation ? 'response') then raise exception 'INVALID_OBSERVATION'; end if;
 if k='dispatch-intent' and (input_count<>0 or forwarded<>0 or p_observation->'response'<>'null'::jsonb
 or p_observation->'sha256'<>'null'::jsonb or (p_observation->>'digestComplete')::boolean)
 then raise exception 'INVALID_OBSERVATION'; end if;
 v:=p_observation->'response';
 if k='response-observed' and jsonb_typeof(v)<>'object' then raise exception 'INVALID_OBSERVATION'; end if;
 if v<>'null'::jsonb then
  if jsonb_typeof(v)<>'object' or v->>'kind' is distinct from 'response'
  or v->>'provenance' is distinct from 'authenticated-storage-response'
  or jsonb_typeof(v->'status') is distinct from 'number' then raise exception 'INVALID_OBSERVATION'; end if;
  n:=(v->>'status')::numeric;
  if n<100 or n>599 or trunc(n)<>n then raise exception 'INVALID_OBSERVATION'; end if;
  foreach k in array array['requestId','version','etag'] loop
   if not(v ? k) or (v->k<>'null'::jsonb and (jsonb_typeof(v->k)<>'string' or length(v->>k)>256)) then raise exception 'INVALID_OBSERVATION'; end if;
  end loop;
  if not(v ? 'acknowledgedBytes') then raise exception 'INVALID_OBSERVATION'; end if;
  if v->'acknowledgedBytes'<>'null'::jsonb then
   if jsonb_typeof(v->'acknowledgedBytes')<>'number' then raise exception 'INVALID_OBSERVATION'; end if;
   n:=(v->>'acknowledgedBytes')::numeric;
   if n<0 or n>9007199254740991 or trunc(n)<>n then raise exception 'INVALID_OBSERVATION'; end if;
  end if;
 end if;
 -- Global operation key also serializes conflicting cross-session reuse. This
 -- transaction-scoped lock is not authority and never spans provider I/O.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation::text,814));
 select * into old from app_private.gateway_write_observations where operation_key=p_operation;
 if found then
  if (old.request_id,old.resource_id,old.owner_id,old.epoch,old.observation)
   is distinct from (p_request,p_resource,p_owner,p_epoch,p_observation) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return old.receipt_id;
 end if;
 insert into app_private.gateway_write_observations(operation_key,request_id,resource_id,owner_id,epoch,observation)
 values(p_operation,p_request,p_resource,p_owner,p_epoch,p_observation) returning receipt_id into result;
 return result;
end $$;
revoke all on function public.ss_gateway_record_write_observation_v1(uuid,uuid,uuid,uuid,bigint,uuid,jsonb)
 from public,anon,authenticated,service_role,ss_gateway_executor,ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
grant execute on function public.ss_gateway_record_write_observation_v1(uuid,uuid,uuid,uuid,bigint,uuid,jsonb) to ss_gateway_executor;
commit;
