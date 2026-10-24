import Link from "next/link";
import { developmentCloudConfig } from "@/lib/backend/development-cloud-config";
import { verifiedAccount } from "@/lib/supabase/server";

export async function cloudPageAccess() {
  try {
    const config = developmentCloudConfig(process.env);
    if (!config) return { state: "disabled" as const };
    const account = await verifiedAccount();
    return account
      ? { state: "authenticated" as const, account }
      : { state: "unauthenticated" as const };
  } catch {
    return { state: "error" as const };
  }
}

export function CloudAccessNotice({
  state,
}: {
  state: "disabled" | "unauthenticated" | "error";
}) {
  if (state === "disabled")
    return (
      <p>
        Development cloud storage is disabled. Local files remain available on
        this device.
      </p>
    );
  if (state === "error")
    return (
      <p role="alert">
        Development cloud storage could not be loaded. No cloud success is
        assumed.
      </p>
    );
  return (
    <p>
      You are not signed in.{" "}
      <Link href="/login?next=/app" prefetch={false}>
        Sign in to development cloud storage
      </Link>
    </p>
  );
}
