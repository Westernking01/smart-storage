import { AppShell } from "@/components/app-shell";
import { AccountFileRecords } from "@/components/account-file-records";
import Link from "next/link";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  return (
    <AppShell>
      <div className="page-heading">
        <div>
          <p className="type-caption">Private cloud workspace</p>
          <h1 className="type-page">My files</h1>
          <p>A place for every file. Every original, ready to restore.</p>
        </div>
      </div>
      <AccountFileRecords cursor={cursor} />
      <p>
        <Link href="/compress">Compress and upload prepared files</Link>
        {" · "}
        <Link href="/local-storage">Local storage on this device</Link>
      </p>
    </AppShell>
  );
}
