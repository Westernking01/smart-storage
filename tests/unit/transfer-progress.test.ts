import { expect, it } from "vitest";
import {
  compressionSummary,
  transferError,
} from "../../src/lib/transfers/progress";
it("reports exact payload sizes and excludes manifest from savings", () => {
  expect(compressionSummary(1000, 250)).toContain(
    "75.0% payload savings (excludes manifest)",
  );
  expect(compressionSummary(1000, 1000)).toContain("0.0%");
  expect(compressionSummary(1000, 1100)).toContain("0.0%");
  expect(compressionSummary(0, 0)).not.toContain("NaN");
});

it("explains integrity, ownership, missing-file and quota errors", () => {
  expect(transferError(Error("ENCODED_INTEGRITY"))).toContain(
    "Integrity verification failed",
  );
  expect(transferError(Error("FORBIDDEN"))).toContain("not authorized");
  expect(transferError(Error("FILE_NOT_FOUND"))).toContain("unavailable");
  expect(transferError(Error("QUOTA_LIMIT"))).toContain("quota limit");
});
