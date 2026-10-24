import { AppShell } from "@/components/app-shell";
import { LocalTransfer } from "@/components/local-transfer";
import { cloudPageAccess } from "@/components/cloud-page-access";

export const dynamic = "force-dynamic";
export default async function Page() {
  const access = await cloudPageAccess();
  return (
    <AppShell>
      <LocalTransfer
        title="Local storage"
        mode="storage"
        ownerId={
          access.state === "authenticated" ? access.account.id : undefined
        }
      />
    </AppShell>
  );
}
