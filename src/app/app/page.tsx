import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { AccountControls } from "@/components/account-controls";
import {
  pageAccount,
  currentAccount,
  listFiles,
} from "@/lib/backend/operations";
import { readCursor } from "@/lib/backend/files";
import { VolumeFiles } from "@/components/volume-files";
import { localVolumeEnabled } from "@/lib/gateway/volume-runtime.server";
import { developmentCloudConfig } from "@/lib/backend/development-cloud-config";
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const context = await pageAccount();
  const developmentCloud = developmentCloudConfig(process.env);
  let data, listing;
  try {
    data = await currentAccount(context);
    listing = data.needsBootstrap
      ? null
      : await listFiles(context, 25, readCursor((await searchParams).cursor));
  } catch {
    return (
      <AppShell>
        <h1 className="type-page">Backend setup required</h1>
        <p>
          Account metadata could not be loaded. Check the reviewed migrations
          and configuration; no statistics are available.
        </p>
        <AccountControls />
      </AppShell>
    );
  }
  return (
    <AppShell>
      <div className="page-heading">
        <div>
          <p className="type-caption">Private workspace</p>
          <h1 className="type-page">My files</h1>
          <p>
            Private file metadata is shown only when the configured backend is
            available.
          </p>
        </div>
        <details>
          <summary>Account</summary>
          <Link href="/account">Account settings</Link>
          <AccountControls />
        </details>
      </div>
      {data.needsBootstrap ? (
        <>
          <p>Finish account setup before loading private metadata.</p>
          <AccountControls bootstrap />
        </>
      ) : (
        <>
          {data.usage && (
            <dl className="account-summary numeric">
              <dt>Stored bytes</dt>
              <dd>{data.usage.storedBytes}</dd>
              <dt>Reserved bytes</dt>
              <dd>{data.usage.reservedBytes}</dd>
              <dt>Quota bytes</dt>
              <dd>{data.usage.quotaBytes}</dd>
              <dt>Active upload slots</dt>
              <dd>
                {data.usage.activeSlots} / {data.usage.maxSlots}
              </dd>
            </dl>
          )}
          {listing?.files.length ? (
            <div className="file-list desktop-file-list premium-file-list">
              <table>
                <caption>Ready private files</caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Original bytes</th>
                    <th>Stored bytes</th>
                    <th>Category</th>
                  </tr>
                </thead>
                <tbody>
                  {listing.files.map((f) => (
                    <tr key={f.id}>
                      <th scope="row">
                        <Link href={`/app/files/${f.id}`}>{f.displayName}</Link>
                      </th>
                      <td>{f.originalBytes}</td>
                      <td>{f.storedBytes}</td>
                      <td>{f.category}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-note">
              {developmentCloud
                ? "No ready files yet. Development cloud controls are below."
                : "No ready files yet. Cloud uploads remain disabled pending provider and quota validation."}
            </p>
          )}
          {!!listing?.files.length && (
            <ul className="mobile-file-list" aria-label="Ready private files">
              {listing.files.map((f) => (
                <li key={f.id}>
                  <Link href={`/app/files/${f.id}`}>{f.displayName}</Link>
                  <dl>
                    <dt>Original bytes</dt>
                    <dd>{f.originalBytes}</dd>
                    <dt>Stored bytes</dt>
                    <dd>{f.storedBytes}</dd>
                    <dt>Category</dt>
                    <dd>{f.category}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          )}
          {listing?.next && (
            <Link href={`/app?cursor=${encodeURIComponent(listing.next)}`}>
              Next page
            </Link>
          )}
        </>
      )}
      <p className="workspace-route">
        <Link href="/app/transfers">Upload session status</Link>
      </p>
      {localVolumeEnabled() && (
        <VolumeFiles key={context.id} ownerId={context.id} />
      )}
      {developmentCloud && !data.needsBootstrap && (
        <VolumeFiles
          key={`cloud-${developmentCloud.project}-${developmentCloud.bucket}-${context.id}`}
          ownerId={context.id}
          cloudScope={`${developmentCloud.project}-${developmentCloud.bucket}`}
        />
      )}
      <p className="workspace-route">
        <Link href="/app/local-transfer">
          Prepare and restore locally for this account
        </Link>
      </p>
      <p className="workspace-route">
        <Link href="/local-transfer">Anonymous local-only feasibility</Link>
      </p>
    </AppShell>
  );
}
