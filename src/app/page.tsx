import { AppShell } from "@/components/app-shell";
import { LocalTransfer } from "@/components/local-transfer";
import { cloudPageAccess } from "@/components/cloud-page-access";
import { OverviewCloud } from "@/components/overview-cloud";
export const dynamic = "force-dynamic";
export default async function HomePage() {
  const access = await cloudPageAccess();
  return (
    <AppShell>
      <div className="overview-layout">
        <LocalTransfer
          title="Overview"
          ownerId={
            access.state === "authenticated" ? access.account.id : undefined
          }
        />
        <OverviewCloud />
      </div>
    </AppShell>
  );
}
