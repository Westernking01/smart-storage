"use client";
export const SESSION_EVENT = "smart-storage-session-change";
/** Conservative invalidation only; events never establish an authenticated identity. */
export function listenSessionChanges(changed: () => void) {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(SESSION_EVENT);
    channel.onmessage = changed;
  } catch {}
  const storage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === SESSION_EVENT ||
      /^sb-.*-auth-token(?:\.\d+)?$/.test(event.key)
    )
      changed();
  };
  window.addEventListener(SESSION_EVENT, changed);
  window.addEventListener("storage", storage);
  window.addEventListener("pagehide", changed);
  return () => {
    channel?.close();
    window.removeEventListener(SESSION_EVENT, changed);
    window.removeEventListener("storage", storage);
    window.removeEventListener("pagehide", changed);
  };
}
export function notifySessionChange() {
  window.dispatchEvent(new Event(SESSION_EVENT));
  try {
    const c = new BroadcastChannel(SESSION_EVENT);
    c.postMessage("changed");
    c.close();
  } catch {}
  try {
    localStorage.setItem(SESSION_EVENT, String(Date.now()));
  } catch {}
}
