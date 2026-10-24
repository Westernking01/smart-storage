"use client";
import { useState } from "react";
import Copy from "@boxicons/react/Copy";
import { Button } from "./ui/button";
export function CopyAccountId({ id }: { id: string }) {
  const [status, setStatus] = useState("");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="account-identity-copy">
      <div className="identity-value">
        <code>
          {id.slice(0, 8)}…{id.slice(-4)}
        </code>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await navigator.clipboard.writeText(id);
              setStatus("Account ID copied.");
              setManual(false);
            } catch {
              setStatus(
                "Clipboard unavailable. Select the account ID below to copy it.",
              );
              setManual(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Copy width={16} height={16} aria-hidden="true" />
          Copy account ID
        </Button>
      </div>
      {manual && (
        <input
          className="ui-input"
          aria-label="Full account ID"
          readOnly
          value={id}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      <p role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
