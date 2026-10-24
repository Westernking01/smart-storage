import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { expressionContract } from "./predecessor-expressions.mjs";
import { triggerContract } from "./predecessor-diagnostics.mjs";

const report = JSON.parse(
  fs.readFileSync(
    new URL(
      "../docs/targeted-postgres-compatibility-objects.20261022.json",
      import.meta.url,
    ),
  ),
);
const digest = (s) =>
  crypto.createHash("sha256").update(JSON.stringify(s)).digest("hex");
for (const row of report.objects.triggers.filter((r) => r.status !== "PASS")) {
  test(`retained trigger: ${row.identity.table}.${row.identity.name}`, () => {
    const candidate = row.expected.definition.replace(
      "update or delete",
      "delete or update",
    );
    assert.equal(digest(candidate), row.observed.fields.definition.sha256);
    assert.equal(
      triggerContract(candidate),
      triggerContract(row.expected.definition),
    );
    for (const changed of [
      candidate.replace("before", "after"),
      candidate.replace("for each row", "for each statement"),
      candidate.replace("execute function", "when (false) execute function"),
      candidate.replace("delete or update", "delete or update of owner_id"),
      candidate.replace("( )", "( 'x' )"),
      candidate.replace("app_private .", "public ."),
    ]) {
      assert.notEqual(triggerContract(changed), triggerContract(candidate));
    }
  });
}
for (const [col, lo, ordinal] of [
  ["epoch", 1, 113],
  ["maximum_bytes", 0, 125],
]) {
  test(`retained CHECK: ${col}`, () => {
    const row = report.objects.constraints.find(
      (r) => r.identity.contractOrdinal === ordinal,
    );
    const ast = JSON.parse(row.expected.definition);
    ast[1][2][2] = ["cast", "bigint", ["value", "'9007199254740991'"]];
    assert.equal(
      digest(JSON.stringify(ast)),
      row.observed.fields.definition.sha256,
    );
    const source = `check (${col} between ${lo} and 9007199254740991)`;
    assert.equal(
      expressionContract(source),
      expressionContract(
        `check (${col} >= ${lo} and ${col} <= '9007199254740991'::bigint)`,
      ),
    );
    for (const bound of [
      "'9007199254740992'::bigint",
      "'9007199254740991'::numeric",
      "'9007199254740991'::integer",
      "other_column::bigint",
    ]) {
      assert.notEqual(
        expressionContract(source),
        expressionContract(`check (${col} >= ${lo} and ${col} <= ${bound})`),
      );
    }
    assert.notEqual(
      expressionContract(source),
      expressionContract(
        `check (${col} > ${lo} and ${col} <= '9007199254740991'::bigint)`,
      ),
    );
  });
}
