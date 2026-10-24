-- Local-only candidate. Applying this to any existing database needs separate
-- authorization. Historical sessions/attempts/evidence are deliberately untouched.
begin;

-- Enroll before ss_reserve returns: a reservation must never have a window in
-- which weaker legacy publication/removal proofs can release its capacity.
-- AFTER INSERT preserves the composite session/owner FK; failure rolls back the
-- entire reservation, including file, usage counters and usage event.
create function app_private.gateway_enroll_reservation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into app_private.gateway_sessions(session_id,owner_id)
 values(new.id,new.owner_id);
 return new;
end $$;
revoke all on function app_private.gateway_enroll_reservation()
 from public,anon,authenticated,service_role,ss_gateway_executor,
 ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
create trigger gateway_reservation_admission after insert on public.upload_sessions
 for each row execute function app_private.gateway_enroll_reservation();

-- Retire alternate runtime write/accounting authority for ALL sessions, including
-- historical unenrolled ones. Do not backfill, discard holds or infer removal.
-- Keep the functions/evidence for historical review, but no application worker
-- receives the legacy size-only/boolean-proof interface. Database owners remain
-- trusted migration administrators, never application runtime identities.
revoke all on function
 public.ss_begin_attempt_request(uuid,bigint,uuid,bigint),
 public.ss_finish_attempt_request(uuid,bigint),
 public.ss_record_observation(uuid,bigint,bigint),
 public.ss_finalize_verified(uuid,jsonb,bigint,text,text),
 public.ss_reconcile_removed_attempt(uuid,boolean,boolean),
 public.ss_settle_cleanup(uuid,boolean,boolean)
 from public,anon,authenticated,service_role,ss_gateway_executor,
 ss_gateway_observer,ss_gateway_finalizer,ss_gateway_cleaner;
commit;
