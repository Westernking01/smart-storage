"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ArchiveArrowDown from "@boxicons/react/ArchiveArrowDown";
import File from "@boxicons/react/File";
import Folder from "@boxicons/react/Folder";
import Image from "@boxicons/react/Image";
import Music from "@boxicons/react/Music";
import { SegmentedProgress } from "@/components/segmented-progress";

type LocalFile = {
  id: string;
  name: string;
  mime: string | null;
  phase: string;
  createdAt: string | null;
  originalBytes: number;
  compressedBytes: number;
};
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / (1024 * 1024)).toFixed(1)} MB`;
const group = (file: LocalFile) => file.mime?.split("/")[0] ?? "other";
const labels: Record<string, string> = {
  image: "Images",
  audio: "Audio",
  video: "Media",
  text: "Documents",
  application: "Documents",
  other: "Other",
};
const icons: Record<string, typeof File> = {
  image: Image,
  audio: Music,
  video: File,
  text: File,
  application: File,
  other: Folder,
};

export function LocalOverview({
  cloudConfigured = false,
}: {
  cloudConfigured?: boolean;
}) {
  const worker = useRef<Worker | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [state, setState] = useState("Loading local browser storage…");
  useEffect(() => {
    if (typeof Worker !== "function" || !globalThis.indexedDB) {
      queueMicrotask(() => setState("Local browser storage is unavailable."));
      return;
    }
    const next = new Worker(
      new URL("../workers/local-transfer.worker.ts", import.meta.url),
    );
    worker.current = next;
    next.onmessage = ({ data }) => {
      if (data.result === "ready") next.postMessage({ method: "list" });
      if (data.result === "listed") {
        setFiles(data.files);
        setState(
          data.files.length
            ? `${data.files.length} local staged ${data.files.length === 1 ? "file" : "files"}.`
            : "No files are staged in this browser yet.",
        );
      }
      if (data.error)
        setState(`Local browser storage could not be read: ${data.error}.`);
    };
    next.postMessage({ method: "ready" });
    const changed = () => next.postMessage({ method: "list" });
    window.addEventListener("smart-storage-local-change", changed);
    return () => {
      window.removeEventListener("smart-storage-local-change", changed);
      next.terminate();
    };
  }, []);
  const metrics = useMemo(
    () =>
      files.reduce(
        (value, file) => ({
          count: value.count + 1,
          original: value.original + file.originalBytes,
          encoded: value.encoded + file.compressedBytes,
        }),
        { count: 0, original: 0, encoded: 0 },
      ),
    [files],
  );
  const reduction = metrics.original
    ? Math.max(
        0,
        ((metrics.original - metrics.encoded) / metrics.original) * 100,
      )
    : 0;
  const encodedRatio = metrics.original
    ? Math.min(100, (metrics.encoded / metrics.original) * 100)
    : 0;
  const savedBytes = Math.max(0, metrics.original - metrics.encoded);
  const categories = useMemo(() => {
    const values = new Map<string, { count: number; bytes: number }>();
    files.forEach((file) => {
      const key = group(file);
      const current = values.get(key) ?? { count: 0, bytes: 0 };
      values.set(key, {
        count: current.count + 1,
        bytes: current.bytes + file.compressedBytes,
      });
    });
    return [...values.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 5)
      .map(([name, data]) => ({
        name,
        ...data,
        percentage: metrics.encoded
          ? Math.min(100, (data.bytes / metrics.encoded) * 100)
          : 0,
      }));
  }, [files, metrics.encoded]);
  const recent = [...files]
    .sort(
      (a, b) =>
        (Date.parse(b.createdAt ?? "") || 0) -
        (Date.parse(a.createdAt ?? "") || 0),
    )
    .slice(0, 4);
  return (
    <section className="overview">
      <header className="overview-heading">
        <div>
          <p className="type-caption">Local browser storage</p>
          <h1 className="type-display">Store smarter, locally.</h1>
          <p>
            Prepare files with verified restoration before cloud transfers are
            available.
          </p>
        </div>
        <Link
          className="ui-button ui-button--primary"
          href="/local-transfer#add-local-file"
        >
          <ArchiveArrowDown width={18} height={18} />
          Compress a file
        </Link>
      </header>
      <p role="status" aria-live="polite" className="overview-status">
        {state}
      </p>
      <section
        className="storage-efficiency-panel"
        aria-label="Original and encoded byte comparison"
      >
        <div className="efficiency-heading">
          <div>
            <p className="type-caption">Storage efficiency</p>
            <h2 className="type-section">Verified local savings</h2>
          </div>
          <span className="verified-label">Verified locally</span>
        </div>
        <div className="efficiency-content">
          <div className="efficiency-primary">
            <strong>{reduction.toFixed(1)}%</strong>
            <span>smaller encoded payload</span>
            <small>{bytes(savedBytes)} saved on this device</small>
          </div>
          <dl className="efficiency-metrics">
            <div>
              <dt>Staged files</dt>
              <dd>{metrics.count}</dd>
            </div>
            <div>
              <dt>Original</dt>
              <dd>{bytes(metrics.original)}</dd>
            </div>
            <div>
              <dt>Encoded</dt>
              <dd>{bytes(metrics.encoded)}</dd>
            </div>
          </dl>
        </div>
        <div className="efficiency-visual">
          <SegmentedProgress
            value={reduction}
            label={`${reduction.toFixed(1)} percent of original bytes saved locally`}
            segments={54}
          />
          <div
            className="efficiency-legend"
            aria-label="Storage efficiency legend"
          >
            <span>
              <i className="legend-dot legend-dot--jade" />
              Saved {reduction.toFixed(1)}%
            </span>
            <span>
              <i className="legend-dot legend-dot--charcoal" />
              Retained {encodedRatio.toFixed(1)}%
            </span>
            <span>{bytes(metrics.original)} original</span>
            <span>{bytes(metrics.encoded)} encoded</span>
          </div>
        </div>
      </section>
      <div className="overview-grid">
        <section className="overview-panel overview-recent">
          <div className="panel-heading">
            <div>
              <p className="type-caption">Recent local files</p>
              <h2 className="type-section">Ready in this browser</h2>
            </div>
            <Link href="/local-transfer">View all</Link>
          </div>
          {recent.length ? (
            <div className="recent-list">
              {recent.map((file) => {
                const Icon = icons[group(file)] ?? File;
                return (
                  <Link
                    key={file.id}
                    href="/local-transfer"
                    className="compact-file-row"
                  >
                    <Icon width={20} height={20} />
                    <span>
                      <strong>{file.name}</strong>
                      <small>
                        {file.mime ?? "Unknown type"} · {file.phase}
                      </small>
                    </span>
                    <span className="compact-file-size">
                      <i className="status-marker" aria-hidden="true" />
                      {bytes(file.compressedBytes)}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="overview-empty">
              <File width={28} height={28} />
              <p>Compress a file to see verified local results here.</p>
              <Link
                className="ui-button ui-button--primary"
                href="/local-transfer#add-local-file"
              >
                Choose a file
              </Link>
            </div>
          )}
        </section>
        <section className="overview-panel">
          <div className="panel-heading">
            <div>
              <p className="type-caption">File types</p>
              <h2 className="type-section">Local breakdown</h2>
            </div>
          </div>
          {categories.length ? (
            <ul className="category-list">
              {categories.map((category) => {
                const Icon = icons[category.name] ?? Folder;
                return (
                  <li key={category.name}>
                    <Icon width={20} height={20} />
                    <div className="category-copy">
                      <span>{labels[category.name] ?? "Other"}</span>
                      <small>
                        {category.count}{" "}
                        {category.count === 1 ? "file" : "files"} ·{" "}
                        {bytes(category.bytes)}
                      </small>
                      <SegmentedProgress
                        value={category.percentage}
                        label={`${labels[category.name] ?? "Other"} represents ${category.percentage.toFixed(1)} percent of encoded bytes`}
                        segments={18}
                        tone="charcoal"
                      />
                    </div>
                    <strong>{category.percentage.toFixed(1)}%</strong>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="overview-empty">
              <Folder width={28} height={28} />
              <p>No local categories yet.</p>
            </div>
          )}
        </section>
      </div>
      <section className="cloud-notice">
        <div>
          <p className="type-caption">Cloud storage</p>
          <h2 className="type-section">
            {cloudConfigured
              ? "Development cloud configured"
              : "Unavailable by design"}
          </h2>
          <p>
            {cloudConfigured
              ? "Open development cloud storage to sign in. Local files remain on this device until explicitly uploaded. Experimental testing only; provider qualification remains incomplete."
              : "Transfers remain disabled until provider and reservation safeguards are verified."}
          </p>
        </div>
        <span className="ui-badge">
          {cloudConfigured ? "Development only" : "Cloud transfers disabled"}
        </span>
      </section>
    </section>
  );
}
