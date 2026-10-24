// Offline diagnostics. Never emit unknown catalog identifiers or definitions.
import crypto from "node:crypto";
import { expressionContract } from "./predecessor-expressions.mjs";
import { tokens } from "./migration-function-comparator.mjs";

const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
const serialize = (v) => JSON.stringify(stable(v));
const same = (a, b) => serialize(a) === serialize(b);
const hash = (v) =>
  crypto
    .createHash("sha256")
    .update(serialize(v) ?? "undefined")
    .digest("hex");

// A single final statement delimiter has no effect on a CREATE TRIGGER.
// The two plain BEFORE row events form a set. Restrict this equivalence to
// the complete reviewed form; never discard WHEN, UPDATE OF or arguments.
export function triggerContract(source) {
  const t = tokens(source);
  if (!t) throw Error("UNSUPPORTED_TRIGGER_TOKENS");
  if (t.at(-1) === ";") t.pop();
  const plainPair =
    /^create trigger [a-z_][\w$]* before (?:update or delete|delete or update) on [a-z_][\w$]* \. [a-z_][\w$]* for each row execute function [a-z_][\w$]* \. [a-z_][\w$]* \( \)$/;
  if (plainPair.test(t.join(" ")) && t[4] === "update") {
    t[4] = "delete";
    t[6] = "update";
  }
  return t.join(" ");
}

function identity(category, row, index) {
  if (category === "ACLs")
    return {
      type: "grant",
      kind: row.kind,
      object: row.object,
      grantee: row.grantee,
      privilege: row.privilege,
      grantor: row.grantor,
    };
  return {
    type: category === "triggers" ? "trigger" : row.kind,
    table: row.table,
    ...(row.name ? { name: row.name } : { contractOrdinal: index }),
    ...(row.columns ? { columns: row.columns } : {}),
  };
}
function key(category, row) {
  if (category === "ACLs")
    return serialize([row.kind, row.object, row.grantee, row.privilege]);
  if (category === "triggers") return serialize([row.table, row.name]);
  return serialize([row.table, row.kind, row.columns]);
}

// Inputs are the SAME normalized multisets used by the compatibility gate.
// Exact matches are consumed first, preserving duplicates. Pairing remaining
// same-identity rows is explanatory only and never promotes the gate to PASS.
export function diagnoseObjects(category, expected, actual) {
  const present = Array.isArray(actual);
  const malformed = present
    ? actual.filter(
        (row) => !row || typeof row !== "object" || Array.isArray(row),
      )
    : [];
  const remaining = present
    ? actual
        .filter((row) => row && typeof row === "object" && !Array.isArray(row))
        .map((row, index) => ({ row, index }))
    : [];
  const pending = [];
  const entries = malformed.map((row) => ({
    identity: { type: "malformed_catalog_row", sha256: hash(row) },
    status: "BLOCKED",
    reason: "MALFORMED_EVIDENCE",
    expected: null,
    observed: { sha256: hash(row) },
    missingFields: [],
    changedFields: [],
  }));
  const add = (e, i, a, reason) => {
    const missingFields = a
      ? Object.keys(e).filter((k) => !Object.hasOwn(a, k))
      : Object.keys(e);
    const changedFields = a
      ? Object.keys(e).filter((k) => Object.hasOwn(a, k) && !same(e[k], a[k]))
      : [];
    const unsupportedFieldCount = a
      ? Object.keys(a).filter((k) => !Object.hasOwn(e, k)).length
      : 0;
    if (unsupportedFieldCount) reason = "UNSUPPORTED_FIELDS";
    if (missingFields.length && a) reason = "INCOMPLETE_EVIDENCE";
    if (reason === "FIELD_MISMATCH" && changedFields.includes("definition")) {
      // Without a trigger grammar, differing token streams cannot prove behavior drift.
      const exact = (v) => {
        if (typeof v !== "string") return false;
        try {
          return JSON.parse(v)?.[0] === "exact";
        } catch {
          return JSON.parse(expressionContract(v))?.[0] === "exact";
        }
      };
      reason =
        category === "triggers" || exact(e.definition) || exact(a.definition)
          ? "UNSUPPORTED_RENDERING_OR_DEFINITION_MISMATCH"
          : "CONTRACT_MISMATCH";
    }
    if (reason === "FIELD_MISMATCH") reason = "CONTRACT_MISMATCH";
    entries.push({
      identity: identity(category, e, i),
      status: "BLOCKED",
      reason,
      expected: e,
      observed: a
        ? {
            sha256: hash(a),
            fields: Object.fromEntries(
              Object.keys(e)
                .filter((k) => Object.hasOwn(a, k))
                .map((k) => [
                  k,
                  same(e[k], a[k])
                    ? { matchesExpected: true }
                    : typeof a[k] === "boolean"
                      ? { matchesExpected: false, value: a[k] }
                      : { matchesExpected: false, sha256: hash(a[k]) },
                ]),
            ),
          }
        : null,
      missingFields,
      changedFields,
      unsupportedFieldCount,
    });
  };
  expected.forEach((e, i) => {
    const n = remaining.findIndex((a) => same(e, a.row));
    if (n >= 0) remaining.splice(n, 1);
    else pending.push({ e, i });
  });
  for (const { e, i } of pending) {
    const n = remaining.findIndex(
      (a) => key(category, e) === key(category, a.row),
    );
    const a = n >= 0 ? remaining.splice(n, 1)[0].row : null;
    add(
      e,
      i,
      a,
      !present
        ? "SECTION_EVIDENCE_UNAVAILABLE"
        : a
          ? "FIELD_MISMATCH"
          : "EXPECTED_ROW_ABSENT",
    );
  }
  for (const { row } of remaining)
    entries.push({
      identity: { type: "unmatched_catalog_row", sha256: hash(row) },
      status: "BLOCKED",
      reason: "UNEXPECTED_OR_UNPAIRED_ROW",
      expected: null,
      observed: { sha256: hash(row) },
      missingFields: [],
      changedFields: [],
    });
  return {
    status: entries.length ? "BLOCKED" : "PASS",
    evidenceAvailable: present,
    expectedCount: expected.length,
    observedCount: present ? actual.length : null,
    entries,
  };
}
