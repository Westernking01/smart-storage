import { displayBytes } from "@/lib/domain/display-bytes";
export function StorageRing({
  used,
  reserved,
  quota,
}: {
  used: bigint;
  reserved: bigint;
  quota: bigint;
}) {
  const percent = (n: bigint) =>
    quota > BigInt(0)
      ? Math.min(100, Number((n * BigInt(10000)) / quota) / 100)
      : 0;
  const complete = percent(used),
    pending = Math.min(100 - complete, percent(reserved));
  const allocated = used + reserved;
  const exact =
    quota > BigInt(0)
      ? Number((allocated * BigInt(1000000)) / quota) / 10000
      : 0;
  const label =
    allocated > BigInt(0) && exact < 0.01
      ? "<0.01%"
      : exact < 1
        ? `${exact.toFixed(2)}%`
        : `${exact.toFixed(1)}%`;
  return (
    <div
      className="storage-ring"
      role="img"
      aria-label={`${displayBytes(used)} completed, ${displayBytes(reserved)} reserved, ${displayBytes(quota)} quota`}
    >
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="ring-track" cx="60" cy="60" r="48" />
        <circle
          className="ring-used"
          cx="60"
          cy="60"
          r="48"
          pathLength="100"
          strokeDasharray={`${complete} ${100 - complete}`}
        />
        <circle
          className="ring-reserved"
          cx="60"
          cy="60"
          r="48"
          pathLength="100"
          strokeDasharray={`${pending} ${100 - pending}`}
          strokeDashoffset={-complete}
        />
      </svg>
      <div>
        <strong>{quota > BigInt(0) ? label : "—"}</strong>
        <span>{quota > BigInt(0) ? "allocated" : "No quota"}</span>
      </div>
    </div>
  );
}
