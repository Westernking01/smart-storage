import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseObjects,
  triggerContract,
} from "./predecessor-diagnostics.mjs";
import { expressionContract } from "./predecessor-expressions.mjs";
import {
  loadPredecessorContracts,
  comparePredecessorCatalog,
} from "./predecessor-contracts.mjs";

const constraint = {
  table: "public.files",
  kind: "check",
  columns: [],
  definition: expressionContract("check (size >= 0)"),
  validated: true,
  deferrable: false,
  deferred: false,
  noInherit: false,
  foreignActions: null,
};
const trigger = {
  table: "public.files",
  name: "owner_immutable",
  enabled: "O",
  definition: triggerContract(
    "create trigger owner_immutable before update on public.files for each row execute function app_private.owner_immutable()",
  ),
};
const grant = {
  kind: "table",
  object: "public.files",
  grantee: "authenticated",
  privilege: "SELECT",
  grantable: false,
  grantor: "postgres",
};

for (const [category, row] of [
  ["constraints", constraint],
  ["triggers", trigger],
  ["ACLs", grant],
]) {
  test(`${category}: exact matches pass; missing section and row remain distinct`, () => {
    assert.equal(diagnoseObjects(category, [row], [row]).status, "PASS");
    assert.equal(
      diagnoseObjects(category, [row], undefined).entries[0].reason,
      "SECTION_EVIDENCE_UNAVAILABLE",
    );
    assert.equal(
      diagnoseObjects(category, [row], []).entries[0].reason,
      "EXPECTED_ROW_ABSENT",
    );
  });
  test(`${category}: missing field blocks and duplicates are retained`, () => {
    const copy = { ...row };
    delete copy[
      category === "ACLs"
        ? "grantable"
        : category === "triggers"
          ? "enabled"
          : "validated"
    ];
    assert.equal(
      diagnoseObjects(category, [row], [copy]).entries[0].reason,
      "INCOMPLETE_EVIDENCE",
    );
    assert.equal(
      diagnoseObjects(category, [row], [row, row]).entries[0].reason,
      "UNEXPECTED_OR_UNPAIRED_ROW",
    );
  });
}
test("constraint: supported expression drift differs from unsupported rendering", () => {
  const drift = {
    ...constraint,
    definition: expressionContract("check (size > 0)"),
  };
  assert.equal(
    diagnoseObjects("constraints", [constraint], [drift]).entries[0].reason,
    "CONTRACT_MISMATCH",
  );
  drift.definition = expressionContract(
    "check (size OPERATOR(private.secret) 0)",
  );
  const result = diagnoseObjects("constraints", [constraint], [drift]);
  assert.equal(
    result.entries[0].reason,
    "UNSUPPORTED_RENDERING_OR_DEFINITION_MISMATCH",
  );
  assert.ok(!JSON.stringify(result).includes("private.secret"));
});
test("constraint: validation drift is explicit and cannot pass", () => {
  const e = diagnoseObjects(
    "constraints",
    [constraint],
    [{ ...constraint, validated: false }],
  ).entries[0];
  assert.deepEqual(e.changedFields, ["validated"]);
  assert.equal(e.observed.fields.validated.value, false);
});
test("trigger: only final delimiter is normalized; WHEN/event/body differences block", () => {
  assert.equal(triggerContract(trigger.definition + ";"), trigger.definition);
  for (const definition of [
    trigger.definition.replace("update", "delete"),
    trigger.definition + " when (false)",
    trigger.definition + ";;",
  ]) {
    const actual = { ...trigger, definition: triggerContract(definition) };
    assert.equal(
      diagnoseObjects("triggers", [trigger], [actual]).status,
      "BLOCKED",
    );
  }
  assert.equal(
    diagnoseObjects("triggers", [trigger], [{ ...trigger, enabled: "D" }])
      .entries[0].changedFields[0],
    "enabled",
  );
});
test("ACL: grant options and grantor are never normalized away", () => {
  for (const change of [
    { grantable: true },
    { grantor: "unknown_private_role" },
  ]) {
    const result = diagnoseObjects("ACLs", [grant], [{ ...grant, ...change }]);
    assert.equal(result.status, "BLOCKED");
    assert.ok(!JSON.stringify(result).includes("unknown_private_role"));
  }
});
test("unrecognized objects are represented only by digests", () => {
  const result = diagnoseObjects(
    "ACLs",
    [grant],
    [{ ...grant, object: "secret_object", grantee: "secret_role" }],
  );
  assert.ok(!JSON.stringify(result).includes("secret_"));
});
test("malformed rows and extra unknown fields block without disclosure", () => {
  assert.equal(
    diagnoseObjects("ACLs", [grant], [null]).entries[0].reason,
    "MALFORMED_EVIDENCE",
  );
  const r = diagnoseObjects(
    "ACLs",
    [grant],
    [{ ...grant, secret_field: "secret_value" }],
  );
  assert.equal(r.entries[0].reason, "UNSUPPORTED_FIELDS");
  assert.equal(r.entries[0].unsupportedFieldCount, 1);
  assert.ok(!JSON.stringify(r).includes("secret_"));
});
test("integrated comparator exposes expected per-object evidence gaps offline", async () => {
  const contract = await loadPredecessorContracts();
  const r = comparePredecessorCatalog(contract, { version: 1 });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.diagnostics.constraints.expectedCount, 247);
  assert.equal(r.diagnostics.triggers.expectedCount, 41);
  assert.ok(r.diagnostics.ACLs.expectedCount > 300);
  for (const d of Object.values(r.diagnostics))
    assert.ok(d.entries.every((e) => e.observed === null));
});
