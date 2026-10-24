import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
};
export function Button({
  className,
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("ui-button", `ui-button--${variant}`, className)}
      {...props}
    />
  );
}
export function IconButton({
  "aria-label": label,
  ...props
}: Omit<ButtonProps, "aria-label"> & { "aria-label": string }) {
  return (
    <Button
      {...props}
      aria-label={label}
      className={cn("ui-icon-button", props.className)}
    />
  );
}
