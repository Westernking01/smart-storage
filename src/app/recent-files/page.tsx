import { AppShell } from "@/components/app-shell";
import { LocalTransfer } from "@/components/local-transfer";
import { cloudPageAccess } from "@/components/cloud-page-access";
import { AccountFileRecords } from "@/components/account-file-records";

export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const access = await cloudPageAccess();
  return (
    <AppShell>
      <LocalTransfer
        title="Recent files"
        mode="recent"
        ownerId={
          access.state === "authenticated" ? access.account.id : undefined
        }
      />
      <AccountFileRecords recent cursor={cursor} />
    </AppShell>
  );
}
