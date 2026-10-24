import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("checks the exact observer assertion block without private schema USAGE", async () => {
  const bootstrap = new PGlite();
  await bootstrap.exec("create database smart_storage_gateway_test");
  const snapshot = await bootstrap.dumpDataDir();
  await bootstrap.close();
  const db = new PGlite({
    database: "smart_storage_gateway_test",
    loadDataDir: snapshot,
  });
  try {
    await db.exec(
      "create role ss_gateway_observer; create role ss_gateway_observer_runtime_test noinherit;",
    );
    await db.exec(
      await readFile("tests/database/seeded-fixture-inspection.sql", "utf8"),
    );
    await db.exec("set role ss_gateway_observer");
    // Reproduce the reported assertion error, not a missing function grant.
    await expect(
      db.query(
        "select has_table_privilege(current_user,'app_private.seeded_fixture_registrations','SELECT')",
      ),
    ).rejects.toThrow("permission denied for schema app_private");
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select has_schema_privilege(current_user,'app_private','USAGE') as allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
    const script = await readFile(
      "tests/database/seeded-fixture-observer-postinstall.sql",
      "utf8",
    );
    const start = script.indexOf("DO $$ DECLARE t oid;");
    expect(start).toBeGreaterThan(-1);
    const block = script.slice(
      start,
      script.indexOf("END $$;", start) + "END $$;".length,
    );
    await db.exec(block);
    await db.exec("reset role");
    expect(
      (
        await db.query<{ empty: boolean }>(
          "select not exists(select from app_private.seeded_fixture_registrations) and not exists(select from app_private.seeded_fixture_receipts) as empty",
        )
      ).rows[0].empty,
    ).toBe(true);
  } finally {
    await db.close();
  }
}, 180000);
