import type { ReactNode } from "react";
import Link from "next/link";
import ArchiveArrowDown from "@boxicons/react/ArchiveArrowDown";
import User from "@boxicons/react/User";
import HardDrive from "@boxicons/react/HardDrive";
import { ShellNavigation, SidebarAccountLink } from "./shell-navigation";
import { WorkspaceHeader } from "./workspace-header";

/** Presentation-only shell; configuration and identity stay in server adapters. */
export function AppFrame({
  children,
  details,
  cloudConfigured = false,
}: {
  children?: ReactNode;
  details?: ReactNode;
  cloudConfigured?: boolean;
}) {
  return (
    <div className="app-stage">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="dashboard-shell">
        <aside className="dashboard-sidebar">
          <Link
            className="wordmark"
            href="/"
            aria-label="Smart Storage overview"
          >
            <span className="brand-mark">
              <ArchiveArrowDown width={22} height={22} aria-hidden="true" />
            </span>
            <span>
              Smart<span className="wordmark-light">Storage</span>
            </span>
          </Link>
          <div className="workspace-selector" aria-label="Current workspace">
            <span className="workspace-symbol">
              <HardDrive
                className="workspace-drive-icon"
                width={20}
                height={20}
                aria-hidden="true"
              />
            </span>
            <span>
              <strong>Your workspace</strong>
              <small>
                {cloudConfigured
                  ? "Local + development cloud"
                  : "Private, on this device"}
              </small>
            </span>
            <span className="workspace-selector-dot" />
          </div>
          <ShellNavigation cloudConfigured={cloudConfigured} />
          <div className="sidebar-foot">
            <div className="sidebar-status">
              <span className="status-dot" />
              <span>
                <strong>Local processing ready</strong>
                <small>
                  {cloudConfigured
                    ? "Development cloud configured"
                    : "Cloud transfers disabled"}
                </small>
              </span>
            </div>
            <SidebarAccountLink>
              <span className="account-avatar" aria-hidden="true">
                <User width={19} height={19} />
              </span>
              <span>
                <strong>Account & security</strong>
                <small>Manage your private account</small>
              </span>
              <span aria-hidden="true">↗</span>
            </SidebarAccountLink>
          </div>
        </aside>
        <section className="dashboard-main">
          <WorkspaceHeader cloudConfigured={cloudConfigured} />
          <div className="dashboard-content">
            <main id="main-content" tabIndex={-1} className="workspace">
              {children}
            </main>
            {details && (
              <aside className="context-panel" aria-label="Contextual details">
                {details}
              </aside>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
