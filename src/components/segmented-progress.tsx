type SegmentedProgressProps = {
  value: number;
  label: string;
  segments?: number;
  tone?: "jade" | "charcoal" | "neutral";
};

export function SegmentedProgress({
  value,
  label,
  segments = 36,
  tone = "jade",
}: SegmentedProgressProps) {
  const safeValue = Math.min(
    100,
    Math.max(0, Number.isFinite(value) ? value : 0),
  );
  const safeSegments = Math.max(1, Math.floor(segments));
  const roundedSegments = Math.round((safeValue / 100) * safeSegments);
  const complete =
    safeValue > 0 && safeValue < 100
      ? Math.min(safeSegments - 1, Math.max(1, roundedSegments))
      : roundedSegments;

  return (
    <div
      className={`segmented-progress segmented-progress--${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safeValue)}
    >
      {Array.from({ length: safeSegments }, (_, index) => (
        <span
          key={index}
          className={index < complete ? "is-complete" : undefined}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
