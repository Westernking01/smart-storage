import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Associate a visible label using htmlFor/id; errors use aria-describedby.
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("ui-input", className)} {...props} />;
}
