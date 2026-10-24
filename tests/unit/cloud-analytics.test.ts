import { expect, it } from "vitest";
import { cloudAnalytics } from "../../src/lib/domain/cloud-analytics";
const b = BigInt;
it("keeps reservation liability separate and classifies each stored byte once", () => {
  const files = [
    {
      category: "image",
      originalBytes: b(100),
      encodedBytes: b(40),
      storedBytes: b(50),
    },
    {
      category: "document",
      originalBytes: b(200),
      encodedBytes: b(20),
      storedBytes: b(50),
    },
  ];
  const result = cloudAnalytics(files, {
    quotaBytes: b(200),
    storedBytes: b(100),
    reservedBytes: b(25),
  });
  expect(result.available).toBe(b(75));
  expect(result.classified).toBe(b(100));
  expect(result.categories.map((c) => c.percentage)).toEqual([50, 50]);
  expect(result.saved).toBe(b(240));
});
it("handles empty, missing metadata, expansion and exhausted capacity without invented savings", () => {
  const result = cloudAnalytics(
    [
      {
        category: "other",
        originalBytes: b(10),
        encodedBytes: b(15),
        storedBytes: null,
      },
    ],
    { quotaBytes: b(10), storedBytes: b(10), reservedBytes: b(5) },
  );
  expect(result.available).toBe(b(0));
  expect(result.saved).toBe(b(-5));
  expect(result.categories).toEqual([]);
  expect(
    cloudAnalytics([], {
      quotaBytes: b(0),
      storedBytes: b(0),
      reservedBytes: b(0),
    }).comparable,
  ).toBe(0);
});
it("preserves exact counts beyond Number precision", () => {
  const huge = b("900719925474099300");
  expect(
    cloudAnalytics([], {
      quotaBytes: huge,
      storedBytes: b(1),
      reservedBytes: b(2),
    }).available,
  ).toBe(huge - b(3));
});
