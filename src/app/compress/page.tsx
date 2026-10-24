import { AppShell } from "@/components/app-shell";
import { LocalTransfer } from "@/components/local-transfer";
import { cloudPageAccess } from "@/components/cloud-page-access";
import { CloudFileActions } from "@/components/cloud-file-actions";

export default async function CompressPage() {
  const access = await cloudPageAccess();
  return (
    <AppShell>
      <LocalTransfer
        title="Compress"
        mode="compress"
        ownerId={
          access.state === "authenticated" ? access.account.id : undefined
        }
      />
      <CloudFileActions />
    </AppShell>
  );
}
