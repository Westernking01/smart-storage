-- psql only. Requires separately verified ordinary browser subject; no guessed account.
\set ON_ERROR_STOP on
\prompt 'Verified ordinary subject UUID: ' subject
BEGIN;
SELECT set_config('ss.dev.subject', :'subject', true);
DO $$ DECLARE a uuid:=current_setting('ss.dev.subject')::uuid; BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=a AND role='authenticated' AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL AND NOT is_anonymous) THEN RAISE EXCEPTION 'Confirmed ordinary user required'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.dev_cloud_accounts WHERE owner_id<>a) THEN RAISE EXCEPTION 'Only one enrolled account'; END IF;
 IF EXISTS(SELECT 1 FROM public.user_usage WHERE owner_id=a AND (stored_bytes<>0 OR reserved_bytes<>0 OR active_slots<>0)) THEN RAISE EXCEPTION 'Existing usage requires separate review'; END IF;
 INSERT INTO public.profiles(id) VALUES(a) ON CONFLICT DO NOTHING;
 INSERT INTO public.user_usage(owner_id,quota_bytes,max_slots) VALUES(a,6422528,1) ON CONFLICT(owner_id) DO UPDATE SET quota_bytes=6422528,max_slots=1;
 INSERT INTO app_private.dev_cloud_accounts VALUES(a,true) ON CONFLICT(owner_id) DO UPDATE SET enabled=true;
END $$;
COMMIT;
