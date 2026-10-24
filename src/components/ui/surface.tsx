import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Surface({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("ui-surface", className)} {...props} />;
}
