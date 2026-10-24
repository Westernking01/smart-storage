import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ownerContext, rpc } from "@/lib/backend/operations";
import { z } from "zod";
const sessions = z
  .array(
    z
      .object({
        id: z.uuid(),
        fileId: z.uuid(),
        state: z.string(),
        heldBytes: z.string().regex(/^\d+$/),
        epoch: z.number().int(),
        expiresAt: z.string(),
      })
      .strict(),
  )
  .max(50);
export default async function Transfers() {
  let items;
  try {
    items = await rpc(await ownerContext(), "ss_sessions", {}, (v) =>
      sessions.parse(v),
    );
  } catch {
    return (
      <AppShell>
        <h1>Session status unavailable</h1>
        <p>No provider request was made to inspect upload resources.</p>
      </AppShell>
    );
  }
  return (
    <AppShell>
      <h1 className="type-page">Upload sessions</h1>
      <p>
        Cloud transfers are disabled. Database reservations do not prove
        provider pre-write enforcement.
      </p>
      {items.length ? (
        <ul>
          {items.map((s) => (
            <li key={s.id}>
              {s.state} — {s.heldBytes} reserved bytes, expiry {s.expiresAt}
            </li>
          ))}
        </ul>
      ) : (
        <p>No upload sessions.</p>
      )}
      <Link href="/app">Back to files</Link>
    </AppShell>
  );
}
