"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./ui/button";
import { notifySessionChange } from "@/lib/backend/session-events";
export function AccountControls({
  bootstrap = false,
}: {
  bootstrap?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const router = useRouter();
  return (
    <>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          if (!bootstrap) notifySessionChange();
          try {
            const result = await fetch(
              bootstrap ? "/api/account" : "/api/auth/logout",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              },
            );
            if (!result.ok) {
              setMessage("The account request could not complete.");
              return;
            }
            if (!bootstrap) {
              router.replace("/login");
            }
            router.refresh();
          } catch {
            setMessage(
              "The account request stopped. Local processing has been fenced.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : bootstrap ? "Finish account setup" : "Sign out"}
      </Button>
      <p role="status">{message}</p>
    </>
  );
}
