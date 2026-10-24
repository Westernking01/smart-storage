import { PGlite } from "@electric-sql/pglite";
import { it } from "vitest";
import { enrollmentChecks } from "../fixtures/development-enrollment-checks";

it("qualifies enrollment, exact privileges, context isolation and guarded removal offline", async () => {
  const db = new PGlite();
  try {
    await enrollmentChecks(db);
  } finally {
    await db.close();
  }
}, 30000);
