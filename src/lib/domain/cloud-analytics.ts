export type AnalyticsFile = {
  category: string;
  originalBytes: bigint;
  encodedBytes: bigint | null;
  storedBytes: bigint | null;
};
export function cloudAnalytics<T extends AnalyticsFile>(
  files: T[],
  usage: { quotaBytes: bigint; storedBytes: bigint; reservedBytes: bigint },
) {
  const categories = new Map<string, bigint>();
  let original = BigInt(0),
    encoded = BigInt(0),
    comparable = 0;
  for (const file of files) {
    if (file.storedBytes !== null)
      categories.set(
        file.category,
        (categories.get(file.category) ?? BigInt(0)) + file.storedBytes,
      );
    if (file.encodedBytes !== null) {
      original += file.originalBytes;
      encoded += file.encodedBytes;
      comparable++;
    }
  }
  const classified = [...categories.values()].reduce(
    (a, b) => a + b,
    BigInt(0),
  );
  const remaining = usage.quotaBytes - usage.storedBytes - usage.reservedBytes;
  return {
    original,
    encoded,
    comparable,
    saved: original - encoded,
    available: remaining > BigInt(0) ? remaining : BigInt(0),
    classified,
    categories: [...categories].map(([category, bytes]) => ({
      category,
      bytes,
      percentage: classified
        ? Number((bytes * BigInt(10000)) / classified) / 100
        : 0,
    })),
    largest: files
      .filter((f) => f.storedBytes !== null)
      .toSorted((a, b) =>
        a.storedBytes! > b.storedBytes!
          ? -1
          : a.storedBytes! < b.storedBytes!
            ? 1
            : 0,
      )
      .slice(0, 5),
  };
}
