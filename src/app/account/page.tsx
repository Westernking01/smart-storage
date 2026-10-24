import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  AccountSettings,
  AccountSettingsState,
} from "@/components/account-settings";
import { ownerContext, BackendError } from "@/lib/backend/operations";
import { ordinaryIdentity } from "@/lib/backend/identity";
export const dynamic = "force-dynamic";
export default async function Account() {
  let account;
  try {
    account = await ownerContext();
  } catch (error) {
    if (error instanceof BackendError && error.code === "UNAUTHENTICATED")
      redirect("/login?next=/account");
    return (
      <AppShell>
        <AccountSettingsState state="error" />
      </AppShell>
    );
  }
  let email: string | null = null;
  try {
    const { data, error } = await account.client.auth.getUser();
    if (
      !error &&
      ordinaryIdentity(data.user) === account.id &&
      typeof data.user?.email === "string"
    )
      email = data.user.email;
  } catch {}
  return (
    <AppShell>
      <AccountSettings
        id={account.id}
        email={email}
        profileUnavailable={!email}
      />
    </AppShell>
  );
}
