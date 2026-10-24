import Link from "next/link";
import File from "@boxicons/react/File";
import Cloud from "@boxicons/react/Cloud";
import ArchiveArrowDown from "@boxicons/react/ArchiveArrowDown";
import { StorageRing } from "./storage-ring";
import { displayBytes } from "@/lib/domain/display-bytes";
import { cloudAnalytics } from "@/lib/domain/cloud-analytics";
import { SegmentedProgress } from "./segmented-progress";
export type AnalyticsDisplayFile = {
  id: string;
  displayName: string;
  category: string;
  originalBytes: bigint;
  encodedBytes: bigint | null;
  storedBytes: bigint | null;
};
export function CloudAnalyticsView({
  files,
  usage,
  truncated = false,
}: {
  files: AnalyticsDisplayFile[];
  usage: { quotaBytes: bigint; storedBytes: bigint; reservedBytes: bigint };
  truncated?: boolean;
}) {
  const stats = cloudAnalytics(files, usage);
  const reduction =
    stats.original > BigInt(0)
      ? Math.max(
          0,
          Number((stats.saved * BigInt(10000)) / stats.original) / 100,
        )
      : 0;
  return (
    <section className="cloud-analytics" aria-label="Cloud storage analytics">
      <div className="storage-dashboard-grid">
        <section className="reference-panel quota-card">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Your private cloud</span>
              <h2>Storage overview</h2>
            </div>
            <Cloud width={22} height={22} aria-hidden="true" />
          </div>
          <StorageRing
            used={usage.storedBytes}
            reserved={usage.reservedBytes}
            quota={usage.quotaBytes}
          />
          <dl className="quota-values">
            <div>
              <dt>Total quota</dt>
              <dd>{displayBytes(usage.quotaBytes)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{displayBytes(stats.available)}</dd>
            </div>
          </dl>
          <div className="storage-legend">
            <span>
              <i className="legend-used" />
              Completed {displayBytes(usage.storedBytes)}
            </span>
            <span>
              <i className="legend-reserved" />
              Reserved {displayBytes(usage.reservedBytes)}
            </span>
          </div>
          <p className="panel-note">
            Pending reservations count toward capacity until settled.
          </p>
        </section>
        <section className="reference-panel savings-card">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Compression impact</span>
              <h2>Smaller files. Same content.</h2>
            </div>
            <ArchiveArrowDown width={22} height={22} aria-hidden="true" />
          </div>
          <div className="savings-hero">
            <strong>
              {reduction.toFixed(1)}
              <span>%</span>
            </strong>
            <span>encoded payload reduction</span>
          </div>
          <SegmentedProgress
            value={reduction}
            segments={60}
            label={`${reduction.toFixed(1)} percent encoded payload reduction`}
          />
          <dl className="comparison-values">
            <div>
              <dt>Original</dt>
              <dd>{displayBytes(stats.original)}</dd>
            </div>
            <div>
              <dt>Encoded</dt>
              <dd>{displayBytes(stats.encoded)}</dd>
            </div>
            <div>
              <dt>Difference</dt>
              <dd>{displayBytes(stats.saved)}</dd>
            </div>
          </dl>
          <p className="panel-note">
            Based on {stats.comparable} comparable ready records. Manifest bytes
            are accounted separately; restoration verifies the original.
          </p>
        </section>
      </div>
      <div className="storage-detail-grid">
        <section className="reference-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">By file type</span>
              <h2>What’s taking space</h2>
            </div>
            <span className="count-label">{files.length} ready files</span>
          </div>
          {stats.categories.length ? (
            <ul className="category-list">
              {stats.categories.map((c, index) => (
                <li key={c.category}>
                  <span className={`category-icon category-icon--${index % 3}`}>
                    <File width={20} height={20} />
                  </span>
                  <div>
                    <strong>{c.category}</strong>
                    <span>{displayBytes(c.bytes)}</span>
                    <div className="category-track">
                      <i style={{ width: `${c.percentage}%` }} />
                    </div>
                  </div>
                  <span className="numeric">{c.percentage.toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="designed-empty">
              <File width={34} height={34} />
              <h3>No cloud files yet</h3>
              <p>
                Your file type breakdown will appear after verified publication.
              </p>
              <Link href="/compress">View prepared files</Link>
            </div>
          )}
          <p className="panel-note">
            Percentages use {displayBytes(stats.classified)} of classified
            stored bytes, including manifests.
            {truncated
              ? " Showing the first 1,000 records; account quota totals remain authoritative."
              : ""}
          </p>
        </section>
        <section className="reference-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Space to consider</span>
              <h2>Largest files</h2>
            </div>
            <Link href="/my-files">View all ↗</Link>
          </div>
          {stats.largest.length ? (
            <ul className="largest-files">
              {stats.largest.map((file) => (
                <li key={file.id}>
                  <span className="file-type-icon">
                    <File width={21} height={21} />
                  </span>
                  <Link href={`/app/files/${file.id}`}>
                    {file.displayName}
                    <small>{file.category}</small>
                  </Link>
                  <strong>{displayBytes(file.storedBytes ?? BigInt(0))}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <div className="designed-empty">
              <Cloud width={34} height={34} />
              <h3>A little breathing room</h3>
              <p>No ready cloud file metadata to show.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
