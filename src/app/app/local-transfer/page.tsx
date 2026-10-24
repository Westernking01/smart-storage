import { AppShell } from "@/components/app-shell";
import { LocalTransfer } from "@/components/local-transfer";
import { pageAccount } from "@/lib/backend/operations";
export default async function LocalAccountTransfer() {
  const account = await pageAccount();
  return (
    <AppShell>
      <LocalTransfer ownerId={account.id} />
    </AppShell>
  );
}
