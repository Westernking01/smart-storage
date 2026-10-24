-- LOCAL ONLY additive contract. Not a Supabase migration. No new roles.
-- Apply once as the existing trusted local administrator; never via observer.
begin;
do $$ begin
 if current_database()<>'smart_storage_gateway_test' then raise exception 'WRONG_LOCAL_TARGET'; end if;
 if inet_server_addr() is not null and inet_server_addr()<>'127.0.0.1'::inet then raise exception 'WRONG_LOCAL_HOST'; end if;
 if current_user<>'postgres' then raise exception 'TRUSTED_ADMIN_REQUIRED'; end if;
 if exists(select 1 from pg_catalog.pg_namespace n join pg_catalog.pg_roles r on r.oid=n.nspowner where n.nspname='app_private' and r.rolname<>'postgres') then raise exception 'UNTRUSTED_SCHEMA_OWNER'; end if;
 if not exists(select 1 from pg_catalog.pg_roles where rolname='ss_gateway_observer' and not (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolcanlogin)) then raise exception 'RESTRICTED_OBSERVER_REQUIRED'; end if;
end $$;
create schema if not exists app_private;
create table app_private.seeded_fixture_registrations (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null check(owner_id='310d0ec8-84ca-423a-b646-0480a20edc09'),
 project text not null check(project='rrylhvqalsxjnkdkpwde'),
 bucket text not null check(bucket='smart-storage-gateway-probe'),
 object_key text not null check(object_key='gateway-probe/v1/probe-fixture-v1.txt'),
 expected_bytes bigint not null check(expected_bytes=123),
 expected_sha256 text not null check(expected_sha256='57d60b8f171ecb27ee614e0a518b3bfba7d8c994bb4daf20c496818970d4c511'),
 provenance text not null check(provenance='externally-seeded-operator-fixture'),
 verification_reference text not null check(length(verification_reference) between 1 and 256),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 check(expires_at>created_at and expires_at<=created_at+interval '30 minutes'),
 unique(project,bucket,object_key)
);
create table app_private.seeded_fixture_receipts (
 id uuid primary key default gen_random_uuid(),
 registration_id uuid not null references app_private.seeded_fixture_registrations(id),
 operation_id uuid not null unique,
 kind text not null check(kind in ('metadata','hash','list')),
 phase text not null check(phase in ('intent','result')),
 producer text not null check(producer='ss_gateway_observer'),
 evidence jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 unique(registration_id,kind,phase)
);
alter table app_private.seeded_fixture_registrations enable row level security;
alter table app_private.seeded_fixture_receipts enable row level security;
revoke all on app_private.seeded_fixture_registrations, app_private.seeded_fixture_receipts from public;

create function public.ss_seeded_fixture_register_v1(p_reference text,p_expires timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 insert into app_private.seeded_fixture_registrations(owner_id,project,bucket,object_key,expected_bytes,expected_sha256,provenance,verification_reference,expires_at)
 values('310d0ec8-84ca-423a-b646-0480a20edc09','rrylhvqalsxjnkdkpwde','smart-storage-gateway-probe','gateway-probe/v1/probe-fixture-v1.txt',123,
 '57d60b8f171ecb27ee614e0a518b3bfba7d8c994bb4daf20c496818970d4c511','externally-seeded-operator-fixture',p_reference,p_expires)
 returning id into result;
 return result;
end $$;

create function public.ss_seeded_fixture_resolve_v1(p_id uuid,p_owner uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r app_private.seeded_fixture_registrations;
begin
 select * into r from app_private.seeded_fixture_registrations where id=p_id and owner_id=p_owner;
 if not found then raise exception 'FORBIDDEN'; end if;
 if r.expires_at<=clock_timestamp() then raise exception 'STALE_SEEDED_REGISTRATION'; end if;
 return jsonb_build_object('operation','seeded-fixture-inspection','provenance',r.provenance,'registrationId',r.id,
 'ownerId',r.owner_id,'project',r.project,'bucket',r.bucket,'path',r.object_key,'declaredBytes',r.expected_bytes,
 'expectedSha256',r.expected_sha256,'verificationReference',r.verification_reference,
 'expiresAt',floor(extract(epoch from r.expires_at)*1000)::bigint);
end $$;

create function public.ss_seeded_fixture_receipt_v1(p_id uuid,p_owner uuid,p_evidence jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare binding jsonb; result uuid; v_kind text; v_phase text; principal text;
begin
 principal:=coalesce(nullif(current_setting('role'),'none'),session_user);
 if principal<>'ss_gateway_observer' then raise exception 'RESTRICTED_OBSERVER_REQUIRED'; end if;
 -- Serialize duplicate/phase checks for a registration; no upload ledger locks.
 perform 1 from app_private.seeded_fixture_registrations where id=p_id for update;
 binding:=public.ss_seeded_fixture_resolve_v1(p_id,p_owner);
 v_kind:=p_evidence->>'kind'; v_phase:=p_evidence->>'phase';
 if p_evidence is null or jsonb_typeof(p_evidence)<>'object' or octet_length(p_evidence::text)>16384
 or not (p_evidence ?& array['operationId','intent','scope','kind','listing','phase','observedAt','direct','inference','classification','retainHolds','certified','futureProviderEffectsPossible'])
 or (p_evidence-array['operationId','intent','scope','kind','listing','phase','observedAt','direct','inference','classification','retainHolds','certified','futureProviderEffectsPossible'])<>'{}'::jsonb
 or jsonb_typeof(p_evidence->'direct') is distinct from 'object'
 or not ((p_evidence->'direct') ?& array['status','bytes','responseBytes','sha256','entries'])
 or ((p_evidence->'direct')-array['status','bytes','responseBytes','sha256','entries'])<>'{}'::jsonb
 or coalesce(p_evidence->>'inference','') not in ('pending','matches','mismatch','incomplete','unknown')
 or p_evidence->'intent' is distinct from binding
 or p_evidence->'scope' is distinct from jsonb_build_object('namespace','rrylhvqalsxjnkdkpwde','uploadId',null,'version',null,'generation',null)
 or p_evidence->'classification' is distinct from '"provisional"'::jsonb
 or p_evidence->'certified' is distinct from 'false'::jsonb
 or p_evidence->'retainHolds' is distinct from 'true'::jsonb
 or p_evidence->'futureProviderEffectsPossible' is distinct from 'true'::jsonb
 or v_kind is null or v_kind not in ('metadata','hash','list') or v_phase is null or v_phase not in ('intent','result')
 or (v_kind='list' and p_evidence->'listing' is distinct from '{"prefix":"gateway-probe/v1/","offset":0,"limit":100}'::jsonb)
 or (v_kind<>'list' and p_evidence->'listing' is distinct from 'null'::jsonb)
 then raise exception 'EVIDENCE_MISMATCH'; end if;
 if (p_evidence->>'observedAt')::timestamptz>clock_timestamp() then raise exception 'EVIDENCE_MISMATCH'; end if;
 if (p_evidence->'direct'->>'status') is not null and (p_evidence->'direct'->>'status')::integer not between 100 and 599 then raise exception 'EVIDENCE_MISMATCH'; end if;
 if (p_evidence->'direct'->>'bytes')::bigint<0 or (p_evidence->'direct'->>'responseBytes')::bigint not between 0 and 65536
 or (p_evidence->'direct'->>'entries')::integer not between 0 and 100
 or ((p_evidence->'direct'->>'sha256') is not null and (p_evidence->'direct'->>'sha256')!~'^[a-f0-9]{64}$')
 then raise exception 'EVIDENCE_MISMATCH'; end if;
 if v_phase='result' and not exists(select 1 from app_private.seeded_fixture_receipts r where r.registration_id=p_id and r.kind=v_kind and r.phase='intent')
 then raise exception 'MISSING_INSPECTION_INTENT'; end if;
 insert into app_private.seeded_fixture_receipts(registration_id,operation_id,kind,phase,producer,evidence)
 values(p_id,(p_evidence->>'operationId')::uuid,v_kind,v_phase,principal,p_evidence) returning id into result;
 return result;
end $$;
revoke all on function public.ss_seeded_fixture_register_v1(text,timestamptz), public.ss_seeded_fixture_resolve_v1(uuid,uuid), public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb) from public;
grant execute on function public.ss_seeded_fixture_resolve_v1(uuid,uuid), public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb) to ss_gateway_observer;
-- Defend against installation-specific default privileges on new private objects.
do $$ declare r text; begin
 foreach r in array array['anon','authenticated','service_role','ss_gateway_executor','ss_gateway_observer','ss_gateway_finalizer','ss_gateway_cleaner','ss_gateway_runtime_test','ss_gateway_observer_runtime_test'] loop
 if exists(select 1 from pg_catalog.pg_roles where rolname=r) then
 execute format('revoke all on app_private.seeded_fixture_registrations,app_private.seeded_fixture_receipts from %I',r);
 execute format('revoke all on function public.ss_seeded_fixture_register_v1(text,timestamptz) from %I',r);
 if r<>'ss_gateway_observer' then
 execute format('revoke all on function public.ss_seeded_fixture_resolve_v1(uuid,uuid),public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb) from %I',r);
 end if;
 end if;
 end loop;
end $$;
commit;
