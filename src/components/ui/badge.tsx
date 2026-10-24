import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <span
      className={cn("ui-badge", `ui-badge--${tone}`, className)}
      {...props}
    />
  );
}
