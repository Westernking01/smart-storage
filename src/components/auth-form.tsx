"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { authInput } from "@/lib/backend/schemas";
import { notifySessionChange } from "@/lib/backend/session-events";
import Eye from "@boxicons/react/Eye";
import EyeClosed from "@boxicons/react/EyeClosed";
type Mode = "login" | "register" | "reset" | "update";
const labels = {
  login: "Sign in",
  register: "Create account",
  reset: "Send recovery instructions",
  update: "Update password",
};
const recoverySuccess =
  "If this address can receive recovery mail, instructions will arrive shortly.";
export function AuthForm({
  mode,
  enabled,
  next = "/app",
}: {
  mode: Mode;
  enabled: boolean;
  next?: string;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !enabled) return;
        const form = e.currentTarget;
        const fields = new FormData(form);
        const input = {
          ...(mode !== "update"
            ? { email: String(fields.get("email") ?? "") }
            : {}),
          ...(mode !== "reset"
            ? { password: String(fields.get("password") ?? "") }
            : {}),
          ...(mode === "login" ? { next } : {}),
        };
        if (!authInput[mode].safeParse(input).success) {
          setMessage(
            "Enter a valid email and password. New passwords require 12–128 characters.",
          );
          return;
        }
        if (
          (mode === "register" || mode === "update") &&
          fields.get("password") !== fields.get("confirm")
        ) {
          setMessage("The passwords do not match.");
          return;
        }
        setBusy(true);
        setMessage("");
        if (mode !== "reset") notifySessionChange();
        try {
          const result = await fetch(`/api/auth/${mode}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          });
          const data = await result.json();
          if (!result.ok) {
            setMessage(
              mode === "login"
                ? "Sign-in failed. Check your credentials and account confirmation."
                : "The request could not complete. Please try again later.",
            );
            return;
          }
          if (mode !== "reset") form.reset();
          if (data.next) {
            notifySessionChange();
            router.replace(data.next);
            router.refresh();
          } else
            setMessage(
              typeof data.message === "string" && data.message
                ? data.message
                : mode === "reset"
                  ? recoverySuccess
                  : "The request completed.",
            );
        } catch {
          setMessage(
            "The request stopped. Check your connection before trying again.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {!enabled && (
        <p role="status">
          Backend setup is required. Authentication is disabled; no account
          request will be sent.
        </p>
      )}
      {mode !== "update" && (
        <>
          <label htmlFor="auth-email">Email address</label>
          <Input
            id="auth-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            disabled={busy}
          />
        </>
      )}
      {mode !== "reset" && (
        <>
          <label htmlFor="auth-password">Password</label>
          <div className="password-field">
            <Input
              id="auth-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              required
              minLength={mode === "login" ? 1 : 12}
              maxLength={128}
              disabled={busy}
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              disabled={busy}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? (
                <EyeClosed width={19} height={19} />
              ) : (
                <Eye width={19} height={19} />
              )}
            </button>
          </div>
        </>
      )}
      {(mode === "register" || mode === "update") && (
        <>
          <label htmlFor="auth-confirm">Confirm password</label>
          <Input
            id="auth-confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            disabled={busy}
          />
          <p className="type-caption">
            Use a unique password with at least 12 characters.
          </p>
        </>
      )}
      <Button type="submit" disabled={!enabled || busy}>
        {busy ? "Working…" : labels[mode]}
      </Button>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <div className="local-actions">
        {mode !== "login" && (
          <Link
            className={
              mode === "register" ? "auth-secondary-action" : undefined
            }
            href="/login"
          >
            Sign in
          </Link>
        )}
        {mode !== "register" && (
          <Link
            className={mode === "login" ? "auth-secondary-action" : undefined}
            href="/register"
          >
            Register
          </Link>
        )}
        <Link href="/forgot-password">Forgot password</Link>
      </div>
    </form>
  );
}
