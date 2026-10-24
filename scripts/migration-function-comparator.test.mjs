import test from "node:test";
import assert from "node:assert/strict";
import {
  reconstructFunctions,
  compareFunction,
  tokens,
} from "./migration-function-comparator.mjs";
const functions = await reconstructFunctions();
const definition = (body) =>
  `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $body$${body}$body$;`;
const expected = { body: "begin raise exception 'DENIED'; end" };
const row = {
  definition: definition(expected.body),
  arguments: "",
  proowner: "postgres",
  prosecdef: true,
  proconfig: ['search_path=""'],
  proacl: ["postgres=X/postgres"],
};
test("matching body and independent complete security contract pass", () =>
  assert.equal(compareFunction(expected, [row], row).status, "PASS"));
test("matching body without security evidence blocks", () =>
  assert.equal(compareFunction(expected, [row]).status, "BLOCKED"));
test("missing function fails", () =>
  assert.equal(compareFunction(expected, []).reason, "MISSING_FUNCTION"));
test("overload ambiguity fails", () =>
  assert.equal(compareFunction(expected, [row, row]).status, "FAIL"));
test("unresolved expectation blocks", () =>
  assert.equal(compareFunction(undefined, [row]).status, "BLOCKED"));
test("real behavior conflict fails", () =>
  assert.equal(
    compareFunction(
      expected,
      [{ ...row, definition: definition("begin return; end") }],
      row,
    ).status,
    "FAIL",
  ));
for (const key of ["arguments", "proowner", "prosecdef", "proconfig", "proacl"])
  test(`${key} drift fails`, () =>
    assert.equal(
      compareFunction(expected, [{ ...row, [key]: null }], row).status,
      "FAIL",
    ));
test("incomplete security evidence blocks", () =>
  assert.equal(compareFunction(expected, [row], {}).status, "BLOCKED"));
test("return type drift fails", () =>
  assert.equal(
    compareFunction(
      expected,
      [
        {
          ...row,
          definition: row.definition.replace("RETURNS void", "RETURNS text"),
        },
      ],
      row,
    ).status,
    "FAIL",
  ));
test("all ordered migration and provisioning patches reconstructed", () => {
  assert.equal(functions.size, 57);
  assert.equal(
    [...functions.values()].filter((v) => v.patches.length).length,
    13,
  );
  assert.equal(
    functions.get("app_private.gateway_identity_guard").patches.length,
    2,
  );
  assert.match(
    functions.get("public.ss_gateway_claim_v1").body,
    /EVIDENCE_QUARANTINED/,
  );
  assert.match(
    functions.get("public.ss_gateway_claim_v1").body,
    /gateway_stream_completions/,
  );
  assert.match(
    functions.get("public.ss_volume_command").body,
    /ACCOUNT_SETUP_REQUIRED/,
  );
  for (const name of [
    "ss_finalize_verified",
    "ss_reconcile_removed_attempt",
    "ss_settle_cleanup",
  ])
    assert.match(functions.get("public." + name).body, /GATEWAY_V1_REQUIRED/);
});
test("unpatched claim rejected and reconstructed claim matches", () => {
  const e = functions.get("public.ss_gateway_claim_v1");
  assert.equal(
    compareFunction(e, [{ definition: definition(e.body) }]).bodyMatches,
    true,
  );
  assert.equal(
    compareFunction(e, [{ definition: e.definition }]).status,
    "FAIL",
  );
});
test("literal contents preserved; outer whitespace and keyword case harmless", () => {
  assert.deepEqual(
    tokens(" BEGIN\n return 1; END "),
    tokens("begin return 1; end"),
  );
  assert.notDeepEqual(tokens("select 'A B'"), tokens("select 'a b'"));
});
test("operator spacing and numeric boundaries remain meaningful", () => {
  assert.notDeepEqual(tokens("a>=b"), tokens("a> =b"));
  assert.notDeepEqual(tokens("select 1.2"), tokens("select 1 . 2"));
  assert.notDeepEqual(tokens("select $$A$$"), tokens("select $$a$$"));
});
test("every patched predecessor rejects its original body", () => {
  for (const e of functions.values()) {
    if (!e.patches.length) continue;
    assert.equal(
      compareFunction(e, [{ definition: definition(e.body) }]).bodyMatches,
      true,
    );
    assert.equal(
      compareFunction(e, [{ definition: e.definition }]).status,
      "FAIL",
    );
  }
});
