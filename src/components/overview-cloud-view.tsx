import Link from "next/link";
import Cloud from "@boxicons/react/Cloud";
import ArrowUpRight from "@boxicons/react/ArrowUpRight";
import { StorageRing } from "./storage-ring";
import { displayBytes } from "@/lib/domain/display-bytes";
export function OverviewCloudView({
  usage,
  files,
  sessions: items,
}: {
  usage: {
    quotaBytes: string;
    storedBytes: string;
    reservedBytes: string;
  } | null;
  files: { id: string; displayName: string; createdAt: string }[] | null;
  sessions: { id: string; state: string; heldBytes: string }[] | null;
}) {
  const active = items?.filter(
    (s) => !["completed", "settled"].includes(s.state),
  );
  return (
    <div className="overview-cloud-panels">
      <section className="reference-panel overview-quota">
        <div className="panel-heading">
          <h2>Cloud capacity</h2>
          <Cloud width={21} height={21} aria-hidden="true" />
        </div>
        {usage ? (
          <>
            <StorageRing
              used={BigInt(usage.storedBytes)}
              reserved={BigInt(usage.reservedBytes)}
              quota={BigInt(usage.quotaBytes)}
            />
            <dl className="quota-values">
              <div>
                <dt>Completed</dt>
                <dd>{displayBytes(usage.storedBytes)}</dd>
              </div>
              <div>
                <dt>Reserved</dt>
                <dd>{displayBytes(usage.reservedBytes)}</dd>
              </div>
            </dl>
            <Link href="/development-cloud">
              View storage <ArrowUpRight width={16} height={16} />
            </Link>
          </>
        ) : (
          <p className="panel-note">Account quota could not be loaded.</p>
        )}
      </section>
      <section className="reference-panel active-transfers">
        <div className="panel-heading">
          <h2>Transfer status</h2>
          <span className="count-label">{active ? active.length : "—"}</span>
        </div>
        {active ? (
          active.length ? (
            <ul>
              {active.slice(0, 4).map((s) => (
                <li key={s.id}>
                  <span className="status-dot" />
                  <div>
                    <strong>{s.state}</strong>
                    <small>{displayBytes(s.heldBytes)} held</small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="quiet-state">
              <span className="status-dot" />
              <p>
                No active upload sessions.
                <small>
                  Prepared files stay safe until you choose to upload.
                </small>
              </p>
            </div>
          )
        ) : (
          <p className="panel-note">Session status is unavailable.</p>
        )}
        <Link href="/compress">
          Prepared files <ArrowUpRight width={16} height={16} />
        </Link>
      </section>
      <section className="reference-panel overview-activity">
        <div className="panel-heading">
          <h2>Recent cloud records</h2>
          <Link href="/recent-files" aria-label="View recent files">
            <ArrowUpRight width={18} height={18} />
          </Link>
        </div>
        {files ? (
          files.length ? (
            <ul>
              {files.map((f) => (
                <li key={f.id}>
                  <Link href={`/app/files/${f.id}`}>{f.displayName}</Link>
                  <time dateTime={f.createdAt}>
                    {new Date(f.createdAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      timeZone: "Africa/Lagos",
                    })}
                  </time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-note">No ready cloud records yet.</p>
          )
        ) : (
          <p className="panel-note">Recent records could not be loaded.</p>
        )}
        <p className="panel-note">Ready records by creation time.</p>
      </section>
    </div>
  );
}
