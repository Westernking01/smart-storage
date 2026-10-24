import type { ReactNode } from "react";
import { AppFrame } from "./app-frame";
import { developmentCloudConfig } from "@/lib/backend/development-cloud-config";
export function AppShell({
  children,
  details,
}: {
  children?: ReactNode;
  details?: ReactNode;
}) {
  let cloudConfigured = false;
  try {
    cloudConfigured = !!developmentCloudConfig(process.env);
  } catch {
    /* Fail closed. */
  }
  return (
    <AppFrame cloudConfigured={cloudConfigured} details={details}>
      {children}
    </AppFrame>
  );
}
