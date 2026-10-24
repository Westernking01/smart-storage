import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const literal = String.raw`(?:E?'(?:''|[^'])*'|\$\w*\$[\s\S]*?\$\w*\$)`;
function decode(s) {
  if (s.startsWith("$"))
    return s.slice(s.indexOf("$", 1) + 1, s.lastIndexOf("$", s.length - 2));
  const escape = s.startsWith("E");
  const value = s.slice(escape ? 2 : 1, -1).replaceAll("''", "'");
  return escape ? value.replaceAll("\\n", "\n") : value;
}
export function bodyOf(definition) {
  return definition?.match(/\bas\s+(\$\w*\$)([\s\S]*?)\1\s*;?\s*$/i)?.[2];
}
// Conservative lexical comparison: never normalize literals or quoted identifiers.
// Comments and whitespace outside tokens have no effect on SQL behavior.
export function tokens(sql) {
  // Block comments are retained conservatively (including nested comments).
  // Multi-character operators, numbers and dollar strings must stay atomic.
  return sql
    .match(
      /\$([a-z_][a-z_0-9]*|)\$[\s\S]*?\$\1\$|E'(?:\\[\s\S]|''|[^'])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|[a-z_][a-z_0-9$]*|\d+(?:\.\d+)?(?:e[+-]?\d+)?|[+*\/<>=~!@#%^&|?\x60-]+|[^\s]/gi,
    )
    ?.filter((t) => !t.startsWith("--"))
    .map((t) => (/^[a-z_][a-z_0-9$]*$/i.test(t) ? t.toLowerCase() : t));
}
export async function reconstructFunctions() {
  const pins = JSON.parse(
    await fs.readFile(
      path.join(root, "scripts/migration-function-sources.json"),
      "utf8",
    ),
  );
  const expected = new Map();
  for (const [file, digest] of Object.entries(pins)) {
    const raw = await fs.readFile(path.join(root, file), "utf8");
    if (hash(raw) !== digest) throw new Error("SOURCE_REVIEW_REQUIRED");
    const source = raw.replaceAll("\r\n", "\n");
    const events = [
      ...source.matchAll(
        /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\([\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\2\s*;|pg_get_functiondef\('([^']+)'::regprocedure\)/gi,
      ),
    ];
    for (const event of events) {
      if (event[1]) {
        expected.set(event[1], {
          body: event[3],
          definition: event[0],
          patches: [],
        });
        continue;
      }
      const name = event[4].split("(")[0];
      const entry = expected.get(name);
      if (!entry) throw new Error("MISSING_PATCH_PREDECESSOR");
      const tail = source.slice(event.index + event[0].length);
      const end = tail.search(/execute (?:d|definition);/i);
      if (end < 0) throw new Error("UNSUPPORTED_PATCH");
      const patch = tail.slice(0, end);
      const variables = new Map(
        [
          ...patch.matchAll(
            new RegExp(`(needle|replacement):=(${literal});`, "g"),
          ),
        ].map((m) => [m[1], decode(m[2])]),
      );
      const replacements = [
        ...patch.matchAll(
          new RegExp(
            `(?:d|definition):=replace\\((?:d|definition),\\s*(${literal}|needle),\\s*(${literal}|replacement)\\s*\\)`,
            "g",
          ),
        ),
      ];
      if (!replacements.length) throw new Error("UNSUPPORTED_PATCH");
      for (const m of replacements) {
        const from = variables.get(m[1]) ?? decode(m[1]);
        const to = variables.get(m[2]) ?? decode(m[2]);
        if (!entry.body.includes(from)) throw new Error("PATCH_ANCHOR_MISSING");
        entry.body = entry.body.replaceAll(from, to);
      }
      entry.patches.push(file);
    }
    // Migration 006's only signature-loop patch uses first, case-insensitive BEGIN.
    if (file.includes("0006_")) {
      for (const name of [
        "public.ss_finalize_verified",
        "public.ss_reconcile_removed_attempt",
        "public.ss_settle_cleanup",
      ]) {
        const entry = expected.get(name);
        const reference = name.includes("reconcile")
          ? "(select session_id from public.transfer_attempts where id=p_attempt)"
          : "p_session";
        entry.body = entry.body.replace(
          /begin/i,
          `begin if exists(select 1 from app_private.gateway_sessions where session_id=${reference}) then raise exception 'GATEWAY_V1_REQUIRED'; end if;`,
        );
        entry.patches.push(file);
      }
    }
  }
  return expected;
}

// Security evidence is independent of a matching body. Caller must supply an
// independently reviewed complete definition/ACL contract; absent evidence blocks.
export function compareFunction(expected, rows, security) {
  if (!expected)
    return { status: "BLOCKED", reason: "EXPECTED_DEFINITION_UNRESOLVED" };
  if (rows.length !== 1)
    return {
      status: security?.contractVersion === 1 ? "BLOCKED" : "FAIL",
      reason: rows.length ? "AMBIGUOUS_FUNCTION" : "MISSING_FUNCTION",
    };
  const row = rows[0];
  const body = bodyOf(row.definition);
  if (!body) return { status: "BLOCKED", reason: "UNSUPPORTED_DEFINITION" };
  if (JSON.stringify(tokens(body)) !== JSON.stringify(tokens(expected.body)))
    return {
      status: security?.contractVersion === 1 ? "BLOCKED" : "FAIL",
      reason: "BODY_CONFLICT",
    };
  if (!security)
    return {
      status: "BLOCKED",
      reason: "SECURITY_CONTRACT_REQUIRED",
      bodyMatches: true,
    };
  // Versioned predecessor contract uses independently derived catalog fields,
  // rather than attempting to equate CREATE source with pg_get_functiondef's
  // CREATE OR REPLACE rendering. ACL expansion/effective checks are mandatory
  // at the aggregate catalog gate as well as the per-function execute list.
  if (security.contractVersion === 1) {
    for (const key of [
      "arguments",
      "proowner",
      "prosecdef",
      "proconfig",
      "result",
      "language",
      "volatility",
      "strict",
      "leakproof",
      "parallel",
      "cost",
      "rows",
      "defaults",
      "execute",
      "support",
    ]) {
      if (!(key in row) || !(key in security))
        return {
          status: "BLOCKED",
          reason: "SECURITY_EVIDENCE_INCOMPLETE",
          bodyMatches: true,
        };
      const normalize = (value) =>
        key === "defaults" && Array.isArray(value)
          ? (tokens(
              value
                .join(",")
                .replace(
                  /\bnull\s*::\s*(?:timestamp with time zone|timestamptz|uuid|text|bigint|integer)\b/gi,
                  "null",
                ),
            ) ?? [])
          : typeof value === "string" && ["arguments", "result"].includes(key)
            ? tokens(
                value.replaceAll("timestamp with time zone", "timestamptz"),
              )
            : value;
      if (
        JSON.stringify(normalize(row[key])) !==
        JSON.stringify(normalize(security[key]))
      )
        return {
          status: "BLOCKED",
          reason: "SECURITY_CONFLICT",
          bodyMatches: true,
        };
    }
    return { status: "PASS", bodyMatches: true };
  }
  for (const key of [
    "arguments",
    "proowner",
    "prosecdef",
    "proconfig",
    "proacl",
  ]) {
    if (!(key in security) || !(key in row))
      return {
        status: "BLOCKED",
        reason: "SECURITY_EVIDENCE_INCOMPLETE",
        bodyMatches: true,
      };
    if (JSON.stringify(row[key]) !== JSON.stringify(security[key]))
      return { status: "FAIL", reason: "SECURITY_CONFLICT", bodyMatches: true };
  }
  // Full pg_get_functiondef contract also covers return type, language, volatility,
  // strictness and other attributes; require independently reviewed evidence.
  if (!security.definition)
    return {
      status: "BLOCKED",
      reason: "FULL_DEFINITION_REQUIRED",
      bodyMatches: true,
    };
  if (
    JSON.stringify(tokens(row.definition)) !==
    JSON.stringify(tokens(security.definition))
  )
    return { status: "FAIL", reason: "DEFINITION_CONFLICT", bodyMatches: true };
  return { status: "PASS", bodyMatches: true };
}
