"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Home from "@boxicons/react/Home";
import File from "@boxicons/react/File";
import ArchiveArrowDown from "@boxicons/react/ArchiveArrowDown";
import Clock from "@boxicons/react/Clock";
import HardDrive from "@boxicons/react/HardDrive";
import Cloud from "@boxicons/react/Cloud";
import Search from "@boxicons/react/Search";
import { useState, type ReactNode } from "react";
export function SidebarAccountLink({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <Link
      className="sidebar-account"
      href="/account"
      prefetch={false}
      aria-current={pathname === "/account" ? "page" : undefined}
    >
      {children}
    </Link>
  );
}
const workspace = [
  { href: "/", label: "Overview", Icon: Home },
  { href: "/my-files", label: "My files", Icon: File },
  {
    href: "/compress",
    label: "Compress",
    Icon: ArchiveArrowDown,
  },
  { href: "/recent-files", label: "Recent files", Icon: Clock },
];
function NavigationGroup({
  label,
  links,
  query,
}: {
  label: string;
  links: typeof workspace;
  query: string;
}) {
  const pathname = usePathname();
  return (
    <div className="nav-group">
      <p>{label}</p>
      {links
        .filter((item) =>
          item.label.toLowerCase().includes(query.toLowerCase()),
        )
        .map(({ href, label: itemLabel, Icon }) => (
          <Link
            key={itemLabel}
            href={href}
            aria-label={itemLabel}
            aria-current={
              !href.includes("#") && pathname === href ? "page" : undefined
            }
          >
            <span className="nav-icon">
              <Icon width={18} height={18} aria-hidden="true" />
            </span>
            <span>{itemLabel}</span>
          </Link>
        ))}
    </div>
  );
}
export function ShellNavigation({
  cloudConfigured = false,
}: {
  cloudConfigured?: boolean;
}) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  return (
    <nav className="shell-nav" aria-label="Primary">
      <label className="nav-search">
        <Search width={17} height={17} aria-hidden="true" />
        <input
          aria-label="Find a page"
          placeholder="Find a page"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <NavigationGroup label="Workspace" links={workspace} query={query} />
      <div className="nav-group">
        <p>Storage</p>
        <Link
          hidden={!!query && !"local storage".includes(query.toLowerCase())}
          href="/local-storage"
          aria-label="Local storage"
          aria-current={pathname === "/local-storage" ? "page" : undefined}
        >
          <span className="nav-icon">
            <HardDrive width={18} height={18} aria-hidden="true" />
          </span>
          <span>Local storage</span>
        </Link>
        <Link
          hidden={!!query && !"cloud storage".includes(query.toLowerCase())}
          href="/development-cloud"
          aria-label="Development cloud storage"
          prefetch={false}
          aria-current={pathname === "/development-cloud" ? "page" : undefined}
        >
          <span className="nav-icon">
            <Cloud width={18} height={18} aria-hidden="true" />
          </span>
          <span>Cloud storage{cloudConfigured ? "" : " (disabled)"}</span>
        </Link>
      </div>
    </nav>
  );
}
