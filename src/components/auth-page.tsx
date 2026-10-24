import { redirect } from "next/navigation";
import { AuthLayout } from "./auth-layout";
import { AuthForm } from "./auth-form";
import { backendConfig, safeNext } from "@/lib/backend/config";
import { verifiedAccount } from "@/lib/supabase/server";
const titles = {
  login: "Welcome back",
  register: "Create your account",
  reset: "Recover account access",
  update: "Choose a new password",
};
export async function AuthPage({
  mode,
  next,
  confirmationFailed = false,
}: {
  mode: keyof typeof titles;
  next?: string;
  confirmationFailed?: boolean;
}) {
  let enabled = false;
  try {
    enabled = !!backendConfig(process.env);
  } catch {}
  let identity = null;
  if (enabled && mode !== "reset") identity = await verifiedAccount();
  if (identity && (mode === "login" || mode === "register")) redirect("/app");
  if (enabled && mode === "update" && !identity) redirect("/forgot-password");
  return (
    <AuthLayout
      title={titles[mode]}
      intro={
        mode === "login"
          ? "A little less space. Everything you need."
          : mode === "register"
            ? "Make space for your files, without losing a byte."
            : mode === "reset"
              ? "We’ll help you get back to your private workspace."
              : "Keep your private workspace protected."
      }
    >
      {confirmationFailed && (
        <p role="alert">
          The confirmation or recovery link could not be verified. Request fresh
          instructions or sign in.
        </p>
      )}
      <AuthForm mode={mode} enabled={enabled} next={safeNext(next)} />
    </AuthLayout>
  );
}
