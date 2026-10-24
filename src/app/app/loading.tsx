import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <p>Loading private account metadata…</p>
      <Skeleton className="loading-row" />
    </div>
  );
}
