import type { ReactNode } from "react";
import Link from "next/link";
import ArchiveArrowDown from "@boxicons/react/ArchiveArrowDown";
import File from "@boxicons/react/File";
import Check from "@boxicons/react/Check";
import { ThemeSelect } from "./theme-select";
export function AuthLayout({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-screen" id="main-content">
      <section className="auth-form-side">
        <Link href="/" className="wordmark" aria-label="Smart Storage overview">
          <span className="brand-mark">
            <ArchiveArrowDown width={22} height={22} aria-hidden="true" />
          </span>
          <span>
            Smart<span className="wordmark-light">Storage</span>
          </span>
        </Link>
        <div className="auth-page">
          <p className="type-caption">Your private workspace</p>
          <h1>{title}</h1>
          <p className="auth-intro">{intro}</p>
          {children}
        </div>
        <footer className="auth-footer">
          <span>Original files. Every byte preserved.</span>
          <ThemeSelect />
        </footer>
      </section>
      <aside className="auth-visual" aria-label="About Smart Storage">
        <span className="auth-visual-label">
          Your files. A smaller footprint.
        </span>
        <div className="auth-art" aria-hidden="true">
          <div className="auth-art-orbit" />
          <div className="auth-art-card auth-art-card--back">
            <File width={80} height={80} />
            <i />
            <i />
            <i />
          </div>
          <div className="auth-art-card auth-art-card--front">
            <span className="auth-art-symbol">
              <ArchiveArrowDown width={76} height={76} />
            </span>
            <div className="auth-art-lines">
              <i />
              <i />
              <i />
            </div>
            <span className="auth-art-check">
              <Check width={22} height={22} />
            </span>
          </div>
          <span className="auth-art-caption">Prepare · Compress · Verify</span>
        </div>
        <div className="auth-visual-copy">
          <span className="type-caption">SMART STORAGE</span>
          <h2>
            More room.
            <br />
            Same original.
          </h2>
          <p>
            Compress on your device. Restore with integrity verification. Save
            when you choose.
          </p>
          <span className="auth-visual-marker" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </aside>
    </main>
  );
}
