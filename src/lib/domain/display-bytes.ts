/** Presentation only; accounting and transfer logic remain in their existing modules. */
export function displayBytes(value: bigint | string | number) {
  const bytes = BigInt(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  let divisor = BigInt(1);
  while (bytes >= divisor * BigInt(1024) && unit < units.length - 1) {
    unit++;
    divisor *= BigInt(1024);
  }
  return unit === 0
    ? `${bytes} B`
    : `${Number((bytes * BigInt(10)) / divisor) / 10} ${units[unit]}`;
}
