import { notFound } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { FileEditor } from "@/components/file-editor";
import { ownerContext, getFile, BackendError } from "@/lib/backend/operations";
import { uuid } from "@/lib/backend/schemas";
import { developmentCloudConfig } from "@/lib/backend/development-cloud-config";
export default async function Detail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const parsed = uuid.safeParse((await params).id);
  if (!parsed.success) notFound();
  let file;
  try {
    file = await getFile(await ownerContext(), parsed.data);
  } catch (e) {
    if (e instanceof BackendError && e.status === 404) notFound();
    return (
      <AppShell>
        <h1>File unavailable</h1>
        <p>Private metadata could not be loaded.</p>
      </AppShell>
    );
  }
  return (
    <AppShell>
      <p>
        <Link href="/app">Back to files</Link>
      </p>
      <h1 className="type-page">{file.displayName}</h1>
      <dl className="local-counts">
        <dt>Original name</dt>
        <dd>{file.originalName}</dd>
        <dt>Type hint</dt>
        <dd>{file.originalMime ?? "Unknown"}</dd>
        <dt>Original bytes</dt>
        <dd>{file.originalBytes}</dd>
        <dt>Encoded bytes</dt>
        <dd>{file.encodedBytes}</dd>
        <dt>Manifest bytes</dt>
        <dd>{file.manifestBytes}</dd>
        <dt>Stored bytes</dt>
        <dd>{file.storedBytes}</dd>
      </dl>
      <p>
        {developmentCloudConfig(process.env) ? (
          <Link href="/app#cloud-heading">
            Download and verify from development cloud files
          </Link>
        ) : (
          "Stored metadata is available. Cloud download and original-byte verification are not enabled."
        )}
      </p>
      <FileEditor file={file} />
    </AppShell>
  );
}
