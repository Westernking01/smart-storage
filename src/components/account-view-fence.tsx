"use client";
import { useEffect, useState, type ReactNode } from "react";
import { listenSessionChanges } from "@/lib/backend/session-events";
export function AccountViewFence({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(true);
  useEffect(() => listenSessionChanges(() => setActive(false)), []);
  return active ? (
    children
  ) : (
    <p role="status">Session changed. Refresh to load account data.</p>
  );
}
