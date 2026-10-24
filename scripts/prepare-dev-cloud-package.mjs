import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = "supabase/development-cloud";
mkdirSync(dir, { recursive: true });
const source = [2, 3].map((n) =>
  readFileSync(
    `supabase/migrations/20261013000${n}_${n === 2 ? "control_functions" : "trusted_transitions_and_rls"}.sql`,
    "utf8",
  ).replaceAll("\r\n", "\n"),
);
const names = [
  "ss_allocate_attempt",
  "ss_begin_attempt_request",
  "ss_finish_attempt_request",
  "ss_record_observation",
  "ss_finalize_verified",
];
let sql = readFileSync(`${dir}/template.sql`, "utf8").replaceAll("\r\n", "\n");
const corrected = [];
for (const name of names) {
  const original = source[name === "ss_allocate_attempt" ? 0 : 1].match(
    new RegExp(`create function public\\.${name}\\(.*?end \\$\\$;`, "s"),
  )[0];
  const body = original.split("as $$")[1].slice(0, -3);
  const hash = createHash("md5").update(body).digest("hex");
  sql += `\nDO $guard$ DECLARE p oid; h text; BEGIN
 SELECT oid INTO STRICT p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='${name}';
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=p;
 IF NOT EXISTS(SELECT 1 FROM app_private.dev_cloud_backup WHERE name='${name}') THEN
 IF h<>'${hash}' THEN RAISE EXCEPTION 'Predecessor mismatch: ${name}'; END IF;
 IF NOT coalesce((SELECT string_agg(x::text,',' ORDER BY x::text) FROM pg_proc CROSS JOIN LATERAL unnest(proacl) x WHERE oid=p) IN (${name === "ss_allocate_attempt" ? "'authenticated=X/postgres,postgres=X/postgres','authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'" : "'postgres=X/postgres,service_role=X/postgres'"}),false) THEN RAISE EXCEPTION 'Predecessor ACL mismatch: ${name}'; END IF;
 INSERT INTO app_private.dev_cloud_backup SELECT '${name}',pg_get_functiondef(p),NULL FROM pg_proc WHERE oid=p;
 ELSIF h IS DISTINCT FROM (SELECT installed_hash FROM app_private.dev_cloud_backup WHERE name='${name}') THEN RAISE EXCEPTION 'Contract drift'; END IF;
END $guard$;\n`;
  let guard = "perform app_private.dev_cloud_owner();\n";
  if (name === "ss_allocate_attempt")
    guard += `IF p_index IS DISTINCT FROM 0 OR p_original IS NULL OR p_original NOT BETWEEN 1 AND 6291456 OR p_encoded IS NULL OR p_encoded NOT BETWEEN 1 AND p_original OR p_codec IS NULL OR p_codec NOT IN ('raw','gzip') OR (p_codec='raw' AND p_encoded<>p_original) THEN RAISE EXCEPTION 'DEV_BLOCK_LIMIT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.upload_sessions s JOIN public.files f ON f.id=s.file_id JOIN public.user_usage u ON u.owner_id=s.owner_id WHERE s.id=p_session AND s.owner_id=app_private.dev_cloud_owner() AND f.original_bytes=p_original AND s.slot_held AND s.held_bytes>=p_encoded+131072 AND u.max_slots=1 AND u.quota_bytes<=6422528 AND u.reserved_bytes>=s.held_bytes AND u.stored_bytes+u.reserved_bytes<=u.quota_bytes) THEN RAISE EXCEPTION 'DEV_QUOTA_BINDING'; END IF;`;
  else {
    guard += `IF auth.jwt()->>'role' IS DISTINCT FROM 'ss_dev_cloud_publisher' THEN RAISE EXCEPTION 'DEV_PUBLISHER_REQUIRED'; END IF;\n`;
    if (name === "ss_finish_attempt_request")
      guard += `IF NOT EXISTS(SELECT 1 FROM app_private.attempt_requests r JOIN public.transfer_attempts a ON a.id=r.attempt_id WHERE r.request_id=p_request AND a.owner_id=app_private.dev_cloud_owner()) THEN RAISE EXCEPTION 'DEV_OWNER'; END IF;`;
    else if (name === "ss_finalize_verified")
      guard += `IF NOT EXISTS(SELECT 1 FROM public.upload_sessions s JOIN storage.objects o ON o.bucket_id='smart-storage-dev-cloud' AND o.name=s.manifest_path WHERE s.id=p_session AND s.owner_id=app_private.dev_cloud_owner() AND o.owner_id=s.owner_id::text AND (o.metadata->>'size')::bigint=p_size) THEN RAISE EXCEPTION 'DEV_MANIFEST_OBJECT_REQUIRED'; END IF;`;
    else {
      guard += `IF NOT EXISTS(SELECT 1 FROM public.transfer_attempts WHERE id=p_attempt AND owner_id=app_private.dev_cloud_owner()) THEN RAISE EXCEPTION 'DEV_OWNER'; END IF;`;
      if (name === "ss_record_observation")
        guard += `IF NOT EXISTS(SELECT 1 FROM public.transfer_attempts a JOIN storage.objects o ON o.bucket_id='smart-storage-dev-cloud' AND o.name=a.object_path WHERE a.id=p_attempt AND a.epoch=p_epoch AND a.acknowledged_bytes=p_size AND a.attempted_bytes=p_size AND o.owner_id=a.owner_id::text AND (o.metadata->>'size')::bigint=p_size) THEN RAISE EXCEPTION 'DEV_BLOCK_OBJECT_REQUIRED'; END IF;`;
    }
  }
  // Rename only PL/pgSQL variables in the original body, before adding guards.
  // Quoted literals are preserved byte-for-byte; table aliases in guards remain
  // table aliases. The fifth RPC has no collision and stays byte-identical.
  const variables = {
    ss_allocate_attempt: {
      a: "v_actor",
      s: "v_session",
      f: "v_file",
      b: "v_block",
    },
    ss_finish_attempt_request: { a: "v_attempt", r: "v_request" },
    ss_record_observation: { a: "v_attempt", s: "v_session" },
    ss_finalize_verified: {
      s: "v_session",
      f: "v_file",
      u: "v_usage",
      b: "v_block",
      d: "v_descriptor",
    },
  }[name];
  const renamed = variables
    ? original.replace(
        /'(?:''|[^'])*'|\b[a-z_]+\b/g,
        (token) => variables[token] ?? token,
      )
    : original;
  let modified = renamed
    .replace("create function", "create or replace function")
    .replace("begin\n", `begin\n${guard}\n`)
    .replace(
      "'storageAuthorityEnabled',false",
      "'storageAuthorityEnabled',true",
    )
    .replace("if number>2", "if number>1");
  sql +=
    modified +
    `\nUPDATE app_private.dev_cloud_backup SET installed_hash=(SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='${name}') WHERE name='${name}';\n`;
  if (name !== "ss_allocate_attempt") {
    const types = original
      .match(/\((.*?)\) returns/s)[1]
      .split(",")
      .map((s) => s.trim().split(" ").at(-1))
      .join(",");
    sql += `REVOKE ALL ON FUNCTION public.${name}(${types}) FROM PUBLIC,anon,authenticated,service_role;\nGRANT EXECUTE ON FUNCTION public.${name}(${types}) TO ss_dev_cloud_publisher;\n`;
  }
  corrected.push({ name, modified, original });
}
sql +=
  readFileSync(`${dir}/policies.sql`, "utf8").replaceAll("\r\n", "\n") +
  "\nCOMMIT;\n";
writeFileSync(`${dir}/install.sql`, sql);

// Frozen pre-correction package proves semantic provenance. The correction builder
// also requires the captured live definitions, including their exact body bytes.
const predecessor = readFileSync(
  "tests/fixtures/development-cloud-pre-alias-install.sql",
  "utf8",
).replaceAll("\r\n", "\n");
const { buildAliasCorrection } =
  await import("./dev-cloud-alias-correction.mjs");
const artifacts = buildAliasCorrection(corrected, predecessor);
for (const [file, content] of Object.entries(artifacts))
  writeFileSync(`${dir}/${file}`, content);
