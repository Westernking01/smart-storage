-- Source fragment only; use install-enrollment.sql after separate authorization.
CREATE FUNCTION public.ss_dev_cloud_enrolled() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_claims pg_catalog.jsonb;
  v_subject pg_catalog.uuid;
BEGIN
  -- current_user is postgres inside SECURITY DEFINER; do not use it
  -- to test the invoking role. The fixed caller must SET LOCAL ROLE.
  IF session_user <> 'ss_dev_cloud_publisher_login'
     OR pg_catalog.current_setting('role', true)
          IS DISTINCT FROM 'ss_dev_cloud_publisher'
     OR pg_catalog.current_setting('transaction_read_only', true)
          IS DISTINCT FROM 'on'
  THEN RETURN false; END IF;

  IF nullif(pg_catalog.current_setting('request.jwt.claim', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '') IS NOT NULL
  THEN RETURN false; END IF;

  v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb;
  v_subject := (v_claims ->> 'sub')::pg_catalog.uuid;
  IF v_subject IS NULL OR v_claims IS DISTINCT FROM
    pg_catalog.jsonb_build_object(
      'sub', v_subject::pg_catalog.text,
      'role', 'ss_dev_cloud_publisher',
      'is_anonymous', false)
  THEN RETURN false; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM app_private.dev_cloud_accounts AS e
    JOIN auth.users AS u ON u.id = e.owner_id
    WHERE e.owner_id = v_subject AND e.enabled
      AND u.role = 'authenticated'
      AND u.email_confirmed_at IS NOT NULL
      AND u.deleted_at IS NULL AND NOT u.is_anonymous
  );
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END;
$function$;
ALTER FUNCTION public.ss_dev_cloud_enrolled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ss_dev_cloud_enrolled()
  FROM PUBLIC, anon, authenticated, service_role, authenticator,
       ss_dev_cloud_publisher_login;
GRANT EXECUTE ON FUNCTION public.ss_dev_cloud_enrolled()
  TO ss_dev_cloud_publisher;
