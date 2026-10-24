import { AppShell } from "@/components/app-shell";
import { AccountSettingsState } from "@/components/account-settings";
export default function Loading() {
  return (
    <AppShell>
      <AccountSettingsState state="loading" />
    </AppShell>
  );
}
