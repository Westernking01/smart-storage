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
