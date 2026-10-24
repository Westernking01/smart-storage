-- REVIEW ONLY: explicitly pinned deployment session; never part of migration sweep.
BEGIN;

SELECT set_config(
  'app.settings.project_ref',
  'fneuqneqaopkmpeevlqz',
  true
);

DO $$ BEGIN
 IF current_setting('app.settings.project_ref',true) IS DISTINCT FROM 'fneuqneqaopkmpeevlqz' THEN RAISE EXCEPTION 'Verified project pin required'; END IF;
 IF to_regclass('app_private.gateway_accounts') IS NOT NULL THEN RAISE EXCEPTION 'Unexpected gateway schema'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND policyname NOT LIKE 'ss_dev_%') THEN RAISE EXCEPTION 'Unexpected Storage policies'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS app_private.dev_cloud_backup(name text PRIMARY KEY, definition text NOT NULL, installed_hash text);
CREATE TABLE IF NOT EXISTS app_private.dev_cloud_accounts(owner_id uuid PRIMARY KEY REFERENCES auth.users(id),enabled boolean NOT NULL DEFAULT false);
REVOKE ALL ON app_private.dev_cloud_backup,app_private.dev_cloud_accounts FROM PUBLIC,anon,authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher') THEN
  IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup) OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit)) THEN RAISE EXCEPTION 'Unexpected existing role'; END IF;
 ELSE
  CREATE ROLE ss_dev_cloud_publisher NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
GRANT ss_dev_cloud_publisher TO authenticator;
GRANT USAGE ON SCHEMA public TO ss_dev_cloud_publisher;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('smart-storage-dev-cloud','smart-storage-dev-cloud',false,6291456,ARRAY['application/octet-stream']) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='smart-storage-dev-cloud' AND name=id AND NOT public AND file_size_limit=6291456 AND allowed_mime_types=ARRAY['application/octet-stream']) THEN RAISE EXCEPTION 'Bucket mismatch'; END IF;
END $$;
CREATE OR REPLACE FUNCTION app_private.dev_cloud_owner() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE a uuid:=auth.uid(); BEGIN
 IF a IS NULL OR auth.jwt()->>'role' IS NULL OR auth.jwt()->>'role' NOT IN ('authenticated','ss_dev_cloud_publisher') OR coalesce((auth.jwt()->>'is_anonymous')::boolean,false) OR NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_accounts WHERE owner_id=a AND enabled) THEN RAISE EXCEPTION 'DEV_ACCOUNT_DISABLED'; END IF;
 RETURN a;
END $$;
REVOKE ALL ON FUNCTION app_private.dev_cloud_owner() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.dev_cloud_owner() TO authenticated;

DO $guard$ DECLARE p oid; h text; BEGIN
 SELECT oid INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_allocate_attempt';
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=p;
 IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup WHERE name='ss_allocate_attempt') THEN
 IF h<>'4dca3c50296711e1da8e0c530e68418e' THEN RAISE EXCEPTION 'Predecessor mismatch: ss_allocate_attempt'; END IF;
 IF NOT coalesce((SELECT string_agg(x::text,',' ORDER BY x::text) FROM pg_proc CROSS JOIN LATERAL unnest(proacl) x WHERE oid=p) IN ('authenticated=X/postgres,postgres=X/postgres','authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),false) THEN RAISE EXCEPTION 'Predecessor ACL mismatch: ss_allocate_attempt'; END IF;
 INSERT INTO app_private.dev_cloud_backup SELECT 'ss_allocate_attempt',pg_get_functiondef(p),NULL FROM pg_proc WHERE oid=p;
 ELSIF h IS DISTINCT FROM (SELECT installed_hash FROM app_private.dev_cloud_backup WHERE name='ss_allocate_attempt') THEN RAISE EXCEPTION 'Contract drift'; END IF;
END $guard$;
create or replace function public.ss_allocate_attempt(p_session uuid,p_index integer,p_original bigint,p_encoded bigint,p_codec text,p_original_hash text,p_encoded_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid:=app_private.actor(); s public.upload_sessions; f public.files; b public.file_blocks; attempt uuid:=gen_random_uuid(); number integer; path text; begin
perform app_private.dev_cloud_owner();
IF p_index IS DISTINCT FROM 0 OR p_original IS NULL OR p_original NOT BETWEEN 1 AND 6291456 OR p_encoded IS NULL OR p_encoded NOT BETWEEN 1 AND p_original OR p_codec IS NULL OR p_codec NOT IN ('raw','gzip') OR (p_codec='raw' AND p_encoded<>p_original) THEN RAISE EXCEPTION 'DEV_BLOCK_LIMIT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.upload_sessions s JOIN public.files f ON f.id=s.file_id JOIN public.user_usage u ON u.owner_id=s.owner_id WHERE s.id=p_session AND s.owner_id=app_private.dev_cloud_owner() AND f.original_bytes=p_original AND s.slot_held AND s.held_bytes>=p_encoded+131072 AND u.max_slots=1 AND u.quota_bytes<=6422528 AND u.reserved_bytes>=s.held_bytes AND u.stored_bytes+u.reserved_bytes<=u.quota_bytes) THEN RAISE EXCEPTION 'DEV_QUOTA_BINDING'; END IF;
  perform 1 from public.user_usage where owner_id=a for update;
  select * into s from public.upload_sessions where id=p_session and owner_id=a for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if s.state='reconciling' then raise exception 'AMBIGUOUS_ATTEMPT_LOCKED'; end if;
  if s.state not in('reserved','uploading') or s.lease_expires_at<=now() then raise exception 'SESSION_EXPIRED_OR_BLOCKED'; end if;
  select * into strict f from public.files where id=s.file_id and owner_id=a for update;
  if p_index is null or p_index<0 or p_index>=greatest(1,(f.original_bytes+8388607)/8388608) or p_original is distinct from least(8388608,f.original_bytes-p_index::bigint*8388608) then raise exception 'INVALID_BLOCK'; end if;
  if exists(select 1 from public.transfer_attempts where session_id=s.id and state in('authorized','in_flight','ambiguous')) then raise exception 'AMBIGUOUS_ATTEMPT_LOCKED'; end if;
  select * into b from public.file_blocks where file_id=f.id and block_index=p_index for update;
  if not found then
    insert into public.file_blocks(file_id,session_id,owner_id,block_index,original_offset,original_bytes,encoded_bytes,codec,original_sha256,encoded_sha256)
    values(f.id,s.id,a,p_index,p_index::bigint*8388608,p_original,p_encoded,p_codec,p_original_hash,p_encoded_hash) returning * into b;
  elsif b.encoded_bytes is distinct from p_encoded or b.codec is distinct from p_codec or b.original_sha256 is distinct from p_original_hash or b.encoded_sha256 is distinct from p_encoded_hash then raise exception 'BLOCK_IMMUTABLE';
  end if;
  if exists(select 1 from public.transfer_attempts where block_id=b.id and state<>'settled') then raise exception 'AMBIGUOUS_ATTEMPT_LOCKED'; end if;
  select coalesce(max(attempt_number),0)+1 into number from public.transfer_attempts where block_id=b.id;
  if number>1 then raise exception 'ATTEMPT_LIMIT'; end if;
  path:='v1/'||a||'/'||f.id||'/'||s.id||'/'||s.epoch||'/'||p_index||'/'||attempt||'.bin';
  insert into public.transfer_attempts(id,block_id,session_id,owner_id,attempt_number,epoch,object_path,authorized_max_bytes,expires_at) values(attempt,b.id,s.id,a,number,s.epoch,path,p_encoded,s.lease_expires_at);
  update public.upload_sessions set state='uploading',revision=revision+1,updated_at=now() where id=s.id;
  return jsonb_build_object('id',attempt,'path',path,'epoch',s.epoch,'authorizedBytes',p_encoded::text,'storageAuthorityEnabled',true);
end $$;
UPDATE app_private.dev_cloud_backup SET installed_hash=(SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_allocate_attempt') WHERE name='ss_allocate_attempt';

DO $guard$ DECLARE p oid; h text; BEGIN
 SELECT oid INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_begin_attempt_request';
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=p;
 IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup WHERE name='ss_begin_attempt_request') THEN
 IF h<>'af08d29e1034acf6214e92bd41a8a5ff' THEN RAISE EXCEPTION 'Predecessor mismatch: ss_begin_attempt_request'; END IF;
 IF NOT coalesce((SELECT string_agg(x::text,',' ORDER BY x::text) FROM pg_proc CROSS JOIN LATERAL unnest(proacl) x WHERE oid=p) IN ('postgres=X/postgres,service_role=X/postgres'),false) THEN RAISE EXCEPTION 'Predecessor ACL mismatch: ss_begin_attempt_request'; END IF;
 INSERT INTO app_private.dev_cloud_backup SELECT 'ss_begin_attempt_request',pg_get_functiondef(p),NULL FROM pg_proc WHERE oid=p;
 ELSIF h IS DISTINCT FROM (SELECT installed_hash FROM app_private.dev_cloud_backup WHERE name='ss_begin_attempt_request') THEN RAISE EXCEPTION 'Contract drift'; END IF;
END $guard$;
create or replace function public.ss_begin_attempt_request(p_attempt uuid,p_epoch bigint,p_request uuid,p_body bigint) returns void language plpgsql security definer set search_path='' as $$
declare a public.transfer_attempts; s public.upload_sessions; r app_private.attempt_requests; begin
perform app_private.dev_cloud_owner();
IF auth.jwt()->>'role' IS DISTINCT FROM 'ss_dev_cloud_publisher' THEN RAISE EXCEPTION 'DEV_PUBLISHER_REQUIRED'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.transfer_attempts WHERE id=p_attempt AND owner_id=app_private.dev_cloud_owner()) THEN RAISE EXCEPTION 'DEV_OWNER'; END IF;
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
UPDATE app_private.dev_cloud_backup SET installed_hash=(SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_begin_attempt_request') WHERE name='ss_begin_attempt_request';
REVOKE ALL ON FUNCTION public.ss_begin_attempt_request(uuid,bigint,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ss_begin_attempt_request(uuid,bigint,uuid,bigint) TO ss_dev_cloud_publisher;

DO $guard$ DECLARE p oid; h text; BEGIN
 SELECT oid INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_finish_attempt_request';
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=p;
 IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup WHERE name='ss_finish_attempt_request') THEN
 IF h<>'1cdb7d095a661890399c5bd41e8a886e' THEN RAISE EXCEPTION 'Predecessor mismatch: ss_finish_attempt_request'; END IF;
 IF NOT coalesce((SELECT string_agg(x::text,',' ORDER BY x::text) FROM pg_proc CROSS JOIN LATERAL unnest(proacl) x WHERE oid=p) IN ('postgres=X/postgres,service_role=X/postgres'),false) THEN RAISE EXCEPTION 'Predecessor ACL mismatch: ss_finish_attempt_request'; END IF;
 INSERT INTO app_private.dev_cloud_backup SELECT 'ss_finish_attempt_request',pg_get_functiondef(p),NULL FROM pg_proc WHERE oid=p;
 ELSIF h IS DISTINCT FROM (SELECT installed_hash FROM app_private.dev_cloud_backup WHERE name='ss_finish_attempt_request') THEN RAISE EXCEPTION 'Contract drift'; END IF;
END $guard$;
create or replace function public.ss_finish_attempt_request(p_request uuid,p_offset bigint) returns void language plpgsql security definer set search_path='' as $$
declare a public.transfer_attempts; r app_private.attempt_requests; begin
perform app_private.dev_cloud_owner();
IF auth.jwt()->>'role' IS DISTINCT FROM 'ss_dev_cloud_publisher' THEN RAISE EXCEPTION 'DEV_PUBLISHER_REQUIRED'; END IF;
IF NOT EXISTS(SELECT 1 FROM app_private.attempt_requests r JOIN public.transfer_attempts a ON a.id=r.attempt_id WHERE r.request_id=p_request AND a.owner_id=app_private.dev_cloud_owner()) THEN RAISE EXCEPTION 'DEV_OWNER'; END IF;
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
UPDATE app_private.dev_cloud_backup SET installed_hash=(SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_finish_attempt_request') WHERE name='ss_finish_attempt_request';
REVOKE ALL ON FUNCTION public.ss_finish_attempt_request(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ss_finish_attempt_request(uuid,bigint) TO ss_dev_cloud_publisher;

DO $guard$ DECLARE p oid; h text; BEGIN
 SELECT oid INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_record_observation';
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=p;
 IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup WHERE name='ss_record_observation') THEN
 IF h<>'ba97d20bf34d99442112f199bd9ae171' THEN RAISE EXCEPTION 'Predecessor mismatch: ss_record_observation'; END IF;
 IF NOT coalesce((SELECT string_agg(x::text,',' ORDER BY x::text) FROM pg_proc CROSS JOIN LATERAL unnest(proacl) x WHERE oid=p) IN ('postgres=X/postgres,service_role=X/postgres'),false) THEN RAISE EXCEPTION 'Predecessor ACL mismatch: ss_record_observation'; END IF;
 INSERT INTO app_private.dev_cloud_backup SELECT 'ss_record_observation',pg_get_functiondef(p),NULL FROM pg_proc WHERE oid=p;
 ELSIF h IS DISTINCT FROM (SELECT installed_hash FROM app_private.dev_cloud_backup WHERE name='ss_record_observation') THEN RAISE EXCEPTION 'Contract drift'; END IF;
END $guard$;
create or replace function public.ss_record_observation(p_attempt uuid,p_epoch bigint,p_size bigint) returns void language plpgsql security definer set search_path='' as $$
declare a public.transfer_attempts; s public.upload_sessions; begin
perform app_private.dev_cloud_owner();
IF auth.jwt()->>'role' IS DISTINCT FROM 'ss_dev_cloud_publisher' THEN RAISE EXCEPTION 'DEV_PUBLISHER_REQUIRED'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.transfer_attempts WHERE id=p_attempt AND owner_id=app_private.dev_cloud_owner()) THEN RAISE EXCEPTION 'DEV_OWNER'; END IF;IF NOT EXISTS(SELECT 1 FROM public.transfer_attempts a JOIN storage.objects o ON o.bucket_id='smart-storage-dev-cloud' AND o.name=a.object_path WHERE a.id=p_attempt AND a.epoch=p_epoch AND a.acknowledged_bytes=p_size AND a.attempted_bytes=p_size AND o.owner_id=a.owner_id::text AND (o.metadata->>'size')::bigint=p_size) THEN RAISE EXCEPTION 'DEV_BLOCK_OBJECT_REQUIRED'; END IF;
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
UPDATE app_private.dev_cloud_backup SET installed_hash=(SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_record_observation') WHERE name='ss_record_observation';
REVOKE ALL ON FUNCTION public.ss_record_observation(uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ss_record_observation(uuid,bigint,bigint) TO ss_dev_cloud_publisher;

DO $guard$ DECLARE p oid; h text; BEGIN
 SELECT oid INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_finalize_verified';
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=p;
 IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup WHERE name='ss_finalize_verified') THEN
 IF h<>'fac2420f3a754824a6c33a3325f73c4d' THEN RAISE EXCEPTION 'Predecessor mismatch: ss_finalize_verified'; END IF;
 IF NOT coalesce((SELECT string_agg(x::text,',' ORDER BY x::text) FROM pg_proc CROSS JOIN LATERAL unnest(proacl) x WHERE oid=p) IN ('postgres=X/postgres,service_role=X/postgres'),false) THEN RAISE EXCEPTION 'Predecessor ACL mismatch: ss_finalize_verified'; END IF;
 INSERT INTO app_private.dev_cloud_backup SELECT 'ss_finalize_verified',pg_get_functiondef(p),NULL FROM pg_proc WHERE oid=p;
 ELSIF h IS DISTINCT FROM (SELECT installed_hash FROM app_private.dev_cloud_backup WHERE name='ss_finalize_verified') THEN RAISE EXCEPTION 'Contract drift'; END IF;
END $guard$;
create or replace function public.ss_finalize_verified(p_session uuid,p_manifest jsonb,p_size bigint,p_sha256 text,p_path text) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.upload_sessions; f public.files; u public.user_usage; count_blocks integer; payload bigint; actual bigint; b public.file_blocks; d jsonb; begin
perform app_private.dev_cloud_owner();
IF auth.jwt()->>'role' IS DISTINCT FROM 'ss_dev_cloud_publisher' THEN RAISE EXCEPTION 'DEV_PUBLISHER_REQUIRED'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.upload_sessions s JOIN storage.objects o ON o.bucket_id='smart-storage-dev-cloud' AND o.name=s.manifest_path WHERE s.id=p_session AND s.owner_id=app_private.dev_cloud_owner() AND o.owner_id=s.owner_id::text AND (o.metadata->>'size')::bigint=p_size) THEN RAISE EXCEPTION 'DEV_MANIFEST_OBJECT_REQUIRED'; END IF;
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
UPDATE app_private.dev_cloud_backup SET installed_hash=(SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='ss_finalize_verified') WHERE name='ss_finalize_verified';
REVOKE ALL ON FUNCTION public.ss_finalize_verified(uuid,jsonb,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ss_finalize_verified(uuid,jsonb,bigint,text,text) TO ss_dev_cloud_publisher;
-- Included by generator; do not deploy separately.
CREATE OR REPLACE FUNCTION app_private.dev_cloud_path(p_name text,p_write boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.upload_sessions s JOIN public.files f ON f.id=s.file_id
 WHERE s.owner_id=app_private.dev_cloud_owner() AND f.owner_id=s.owner_id AND
 ((p_write AND s.state='uploading' AND s.lease_expires_at>now() AND s.slot_held) OR
 (NOT p_write AND s.state IN ('uploading','completed') AND f.state IN ('uploading','ready'))) AND
 (EXISTS(SELECT 1 FROM public.transfer_attempts a WHERE a.session_id=s.id AND a.owner_id=s.owner_id AND a.epoch=s.epoch AND a.object_path=p_name AND
 ((p_write AND a.state='in_flight' AND EXISTS(SELECT 1 FROM app_private.attempt_requests r WHERE r.attempt_id=a.id AND r.state='reserved')) OR (NOT p_write AND a.state IN ('in_flight','present'))))
 OR (p_name=s.manifest_path AND EXISTS(SELECT 1 FROM public.file_blocks b WHERE b.session_id=s.id) AND NOT EXISTS(SELECT 1 FROM public.file_blocks b WHERE b.session_id=s.id AND b.state<>'present'))))
$$;
REVOKE ALL ON FUNCTION app_private.dev_cloud_path(text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.dev_cloud_path(text,boolean) TO authenticated;
DROP POLICY IF EXISTS ss_dev_bucket_read ON storage.buckets;
CREATE POLICY ss_dev_bucket_read ON storage.buckets FOR SELECT TO authenticated USING(id='smart-storage-dev-cloud' AND app_private.dev_cloud_owner()=auth.uid());
DROP POLICY IF EXISTS ss_dev_object_insert ON storage.objects;
CREATE POLICY ss_dev_object_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='smart-storage-dev-cloud' AND owner_id=auth.uid()::text AND app_private.dev_cloud_path(name,true));
DROP POLICY IF EXISTS ss_dev_object_read ON storage.objects;
CREATE POLICY ss_dev_object_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='smart-storage-dev-cloud' AND owner_id=auth.uid()::text AND app_private.dev_cloud_path(name,false));

COMMIT;
