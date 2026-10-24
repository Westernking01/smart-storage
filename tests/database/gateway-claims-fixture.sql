-- Disposable local database ONLY, after migrations 001-004.
insert into auth.users(id) values
 ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.profiles(id) select id from auth.users;
insert into public.user_usage(owner_id,quota_bytes,reserved_bytes,active_slots,max_slots)
 select id,1048576,262160,2,2 from auth.users;
insert into app_private.gateway_accounts(owner_id,max_active_streams,bucket)
 select id,1,'local-gateway-test' from auth.users;
insert into public.files(id,owner_id,original_name,display_name,original_bytes,source_sha256)
 select ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 ('00000000-0000-0000-0000-'||lpad(((n+1)/2)::text,12,'0'))::uuid,'test','test',8,repeat('a',64)
 from generate_series(1,4) n;
insert into public.upload_sessions(id,file_id,owner_id,idempotency_key,request_digest,state,held_bytes,lease_expires_at,initial_source_sha256,manifest_path)
 select ('20000000-0000-0000-0000-'||right(id::text,12))::uuid,id,owner_id,
 'local-test-key-00'||right(id::text,1),'fixture','uploading',131080,clock_timestamp()+interval '1 day',repeat('a',64),'local/'||id||'/manifest'
 from public.files;
insert into public.file_blocks(id,file_id,session_id,owner_id,block_index,original_offset,original_bytes,encoded_bytes,codec,original_sha256,encoded_sha256)
 select ('30000000-0000-0000-0000-'||right(id::text,12))::uuid,file_id,id,owner_id,0,0,8,8,'raw',repeat('a',64),repeat('a',64)
 from public.upload_sessions;
insert into public.transfer_attempts(id,block_id,session_id,owner_id,epoch,object_path,authorized_max_bytes,expires_at)
 select ('40000000-0000-0000-0000-'||right(id::text,12))::uuid,id,session_id,owner_id,1, 'v1/'||owner_id||'/'||file_id||'/'||session_id||'/1/0/'||
 ('40000000-0000-0000-0000-'||right(id::text,12))||'.bin',8,clock_timestamp()+interval '1 day'
 from public.file_blocks;
