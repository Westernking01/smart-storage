-- Independent login, no fixture registration. ROLLBACK; null IDs touch no rows.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 ASSERT session_user='ss_gateway_observer_runtime_test' AND current_user=session_user;
 ASSERT current_database()='smart_storage_gateway_test';
 ASSERT inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432;
 ASSERT NOT has_function_privilege(current_user,'public.ss_seeded_fixture_register_v1(text,timestamptz)','EXECUTE');
 ASSERT NOT has_function_privilege(current_user,'public.ss_seeded_fixture_resolve_v1(uuid,uuid)','EXECUTE');
 ASSERT NOT has_function_privilege(current_user,'public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb)','EXECUTE');
END $$;
SET LOCAL ROLE ss_gateway_observer;
DO $$ DECLARE t oid; BEGIN
 ASSERT current_user='ss_gateway_observer';
 ASSERT NOT has_function_privilege(current_user,'public.ss_seeded_fixture_register_v1(text,timestamptz)','EXECUTE');
 ASSERT has_function_privilege(current_user,'public.ss_seeded_fixture_resolve_v1(uuid,uuid)','EXECUTE');
 ASSERT has_function_privilege(current_user,'public.ss_seeded_fixture_receipt_v1(uuid,uuid,jsonb)','EXECUTE');
 ASSERT NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'ss_%'
 AND has_function_privilege(current_user,p.oid,'EXECUTE')
 AND p.proname NOT IN ('ss_gateway_discover_resource_v1','ss_gateway_reconcile_discoveries_v1',
 'ss_gateway_record_receipt_v1','ss_seeded_fixture_resolve_v1','ss_seeded_fixture_receipt_v1'));
 -- Use catalog OIDs: text relation lookup requires private-schema USAGE.
 -- Privilege inspection must not require the access it is checking is denied.
 FOR t IN SELECT c.oid
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p') LOOP
 ASSERT NOT has_table_privilege(current_user,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
 ASSERT NOT has_any_column_privilege(current_user,t,'SELECT,INSERT,UPDATE,REFERENCES');
 END LOOP;
 -- A null registration never exists; FORBIDDEN proves entry into both functions.
 BEGIN
 PERFORM public.ss_seeded_fixture_resolve_v1(NULL,NULL);
 RAISE EXCEPTION 'EXPECTED_FORBIDDEN';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
 BEGIN
 PERFORM public.ss_seeded_fixture_receipt_v1(NULL,NULL,'{}');
 RAISE EXCEPTION 'EXPECTED_FORBIDDEN';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
 BEGIN EXECUTE 'SELECT * FROM app_private.seeded_fixture_registrations';
 RAISE EXCEPTION 'EXPECTED_DENIAL'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN EXECUTE 'SELECT * FROM app_private.seeded_fixture_receipts';
 RAISE EXCEPTION 'EXPECTED_DENIAL'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;
SELECT 'PASS independent observer identity, intended function entry, registration privilege denied, private access denied; no registration performed';
