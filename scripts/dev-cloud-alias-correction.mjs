import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const md5 = (s) => createHash("md5").update(s).digest("hex");
const literal = (s) =>
  `E'${s.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("\r", "\\r").replaceAll("\n", "\\n")}'`;
function describe(sql) {
  const [, name, argumentsText, result, body] = sql.match(
    /function public\.(\w+)\((.*?)\) returns (\w+) language plpgsql security definer set search_path='' as \$\$(.*?)\$\$;/s,
  );
  const args = argumentsText
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "));
  const signature = `public.${name}(${args.map((s) => s.split(" ").at(-1)).join(",")})`;
  // pg_get_functiondef's canonical PostgreSQL representation. Tests compare the
  // whole definition, not merely a body hash, and fail closed on version drift.
  const definition = `CREATE OR REPLACE FUNCTION public.${name}(${args.join(", ")})\n RETURNS ${result}\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''\nAS $function$${body}$function$\n`;
  return { name, signature, body, definition, sql };
}

export function buildAliasCorrection(entries, predecessor) {
  const snapshot = JSON.parse(
    readFileSync(
      "tests/fixtures/development-cloud-live-alias-baseline.json",
      "utf8",
    ),
  );
  if (
    snapshot.project !== "fneuqneqaopkmpeevlqz" ||
    snapshot.functions.length !== 5
  )
    throw new Error("Invalid live baseline");
  const pairs = entries.map(({ name, modified, original }) => {
    const old = predecessor.match(
      new RegExp(
        `create or replace function public\\.${name}\\(.*?end \\$\\$;`,
        "s",
      ),
    )[0];
    const live = snapshot.functions.find((row) => row.name === name);
    const prior = describe(old);
    const base = describe(original);
    const next = describe(modified);
    if (
      !live ||
      live.owner !== "postgres" ||
      live.definition.replaceAll("\r\n", "\n") !== prior.definition ||
      live.backup_definition !== base.definition
    )
      throw new Error(`Live semantic/backup drift: ${name}`);
    const liveBody = live.definition
      .split("AS $function$")[1]
      .split("$function$")[0];
    if (
      md5(liveBody) !== live.body_hash ||
      live.installed_hash !== live.body_hash
    )
      throw new Error(`Live hash drift: ${name}`);
    // Preserve the verified server's body bytes; only variable identifiers change.
    const body = next.body.replaceAll("\n", "\r\n");
    const exact = (definition, body) => ({
      ...prior,
      definition,
      body,
      sql: definition.split("AS $function$")[0] + "AS " + literal(body) + ";",
    });
    return {
      old: exact(live.definition, liveBody),
      next: exact(
        next.definition.replace(next.body, () => body),
        body,
      ),
      base,
    };
  });
  const guard = (item, base) => {
    const acls =
      item.name === "ss_allocate_attempt"
        ? [
            "authenticated=X/postgres,postgres=X/postgres",
            "authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres",
          ]
        : ["postgres=X/postgres,ss_dev_cloud_publisher=X/postgres"];
    return `
 p := to_regprocedure(${literal(item.signature)});
 IF p IS NULL OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=${literal(item.name)})<>1 THEN RAISE EXCEPTION 'Alias correction signature drift: ${item.name}'; END IF;
 IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=p) IS DISTINCT FROM 'postgres'
 OR pg_get_functiondef(p) IS DISTINCT FROM ${literal(item.definition)}
 OR NOT coalesce((SELECT string_agg(acl::text,',' ORDER BY acl::text) FROM pg_proc CROSS JOIN LATERAL unnest(proacl) acl WHERE oid=p) IN (${acls.map(literal).join(",")}),false)
 THEN RAISE EXCEPTION 'Alias correction definition/privilege drift: ${item.name}'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup WHERE name=${literal(item.name)} AND installed_hash=${literal(md5(item.body))} AND definition=${literal(base.definition)}) THEN RAISE EXCEPTION 'Alias correction backup drift: ${item.name}'; END IF;
`;
  };
  const build = (reverse) => {
    let sql = `-- REVIEW ONLY: ${reverse ? "restore pre-alias definitions" : "alias-only correction"}; no provisioning or activation.
-- Stop the development app; independently verify the target and set the session
-- app.settings.project_ref externally. Do not run concurrently with other DDL.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF current_setting('app.settings.project_ref',true) IS DISTINCT FROM 'fneuqneqaopkmpeevlqz' THEN RAISE EXCEPTION 'Verified project pin required'; END IF;
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'Expected postgres owner'; END IF;
 IF to_regclass('app_private.gateway_accounts') IS NOT NULL THEN RAISE EXCEPTION 'Unexpected gateway schema'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ss_dev_cloud_publisher' AND NOT (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit)) THEN RAISE EXCEPTION 'Publisher role drift'; END IF;
END $$;
LOCK TABLE app_private.dev_cloud_backup IN SHARE ROW EXCLUSIVE MODE;
DO $guard$ DECLARE p oid; BEGIN
`;
    for (const pair of pairs)
      sql += guard(reverse ? pair.next : pair.old, pair.base);
    sql += "END $guard$;\n";
    for (const pair of pairs.filter(
      ({ old }) => old.name !== "ss_begin_attempt_request",
    )) {
      const target = reverse ? pair.old : pair.next;
      sql += `${target.sql}\nUPDATE app_private.dev_cloud_backup SET installed_hash=${literal(md5(target.body))} WHERE name=${literal(target.name)};\n`;
    }
    sql += "DO $guard$ DECLARE p oid; BEGIN\n";
    for (const pair of pairs)
      sql += guard(reverse ? pair.old : pair.next, pair.base);
    sql +=
      "END $guard$;\n-- No ACL, role, policy, bucket, account or accounting changes.\nCOMMIT;\n";
    return sql;
  };
  return {
    "correct-aliases.sql": build(false),
    "rollback-aliases.sql": build(true),
  };
}
