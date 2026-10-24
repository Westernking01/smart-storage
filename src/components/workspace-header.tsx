"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Grid from "@boxicons/react/Grid";
import ArrowUpRight from "@boxicons/react/ArrowUpRight";
import { ThemeSelect } from "./theme-select";
const names: Record<string, string> = {
  "/": "Overview",
  "/my-files": "My files",
  "/compress": "Compress",
  "/recent-files": "Recent files",
  "/local-storage": "Local storage",
  "/development-cloud": "Cloud storage",
  "/account": "Account & security",
};
export function WorkspaceHeader({
  cloudConfigured,
}: {
  cloudConfigured: boolean;
}) {
  const pathname = usePathname();
  return (
    <header className="app-header">
      <div className="header-context">
        <Grid width={18} height={18} aria-hidden="true" />
        <span>Workspace</span>
        <span className="header-slash" aria-hidden="true">
          /
        </span>
        <strong>{names[pathname] ?? "Private files"}</strong>
      </div>
      <div className="header-actions">
        <span className="environment-label">
          <i />
          {cloudConfigured ? "Development" : "Local only"}
        </span>
        <ThemeSelect />
        <Link
          href="/account"
          className="header-account"
          aria-label="Account settings"
          aria-current={pathname === "/account" ? "page" : undefined}
        >
          <ArrowUpRight width={18} height={18} aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}
