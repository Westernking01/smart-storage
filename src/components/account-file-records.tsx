import { CloudRecordBrowser } from "./cloud-record-browser";
import Link from "next/link";
import { cloudPageAccess, CloudAccessNotice } from "./cloud-page-access";
import { readCursor } from "@/lib/backend/files";
import { listFiles } from "@/lib/backend/operations";
export async function AccountFileRecords({
  recent = false,
  cursor,
}: {
  recent?: boolean;
  cursor?: string;
}) {
  const access = await cloudPageAccess();
  if (access.state !== "authenticated")
    return (
      <section aria-label="Account file records">
        <h2 className="type-section">
          {recent ? "Recent account records" : "Account file records"}
        </h2>
        <CloudAccessNotice state={access.state} />
      </section>
    );
  let listing;
  try {
    listing = await listFiles(access.account, 25, readCursor(cursor));
  } catch {
    return <p role="alert">Account file records could not be loaded.</p>;
  }
  const files = [...listing.files].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  return (
    <section aria-label="Account file records" className="account-file-records">
      <h2 className="type-section record-section-title">
        {recent ? "Recent account records" : "Account file records"}
      </h2>
      <p className="record-section-description">
        Private, ready files. Restore and verify an original whenever you need
        it.
      </p>
      {
        <CloudRecordBrowser
          key={access.account.id}
          ownerId={access.account.id}
          recent={recent}
          nextHref={
            listing.next
              ? `/${recent ? "recent-files" : "my-files"}?cursor=${encodeURIComponent(listing.next)}`
              : undefined
          }
          files={files.map((f) => ({
            id: f.id,
            name: f.displayName,
            bytes: String(f.storedBytes ?? "0"),
            createdAt: f.createdAt,
            originalName: f.originalName,
            originalMime: f.originalMime,
            originalBytes: String(f.originalBytes),
            revision: f.revision,
            category: f.category,
          }))}
        />
      }
      <Link href={recent ? "/my-files" : "/compress"} prefetch={false}>
        {recent
          ? "Manage cloud files in My Files"
          : "Upload prepared files from Compress"}
      </Link>
    </section>
  );
}
