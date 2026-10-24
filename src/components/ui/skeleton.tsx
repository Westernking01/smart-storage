import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Presentational only; the containing region must label its real loading state.
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cn("ui-skeleton", className)}
    />
  );
}
