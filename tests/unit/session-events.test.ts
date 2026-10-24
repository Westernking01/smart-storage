import { afterEach, expect, it, vi } from "vitest";
import {
  listenSessionChanges,
  SESSION_EVENT,
} from "@/lib/backend/session-events";

afterEach(() => vi.unstubAllGlobals());
it("fences window, storage, channel and navigation events and removes every listener", () => {
  const target = new EventTarget();
  const add = vi.spyOn(target, "addEventListener");
  const remove = vi.spyOn(target, "removeEventListener");
  vi.stubGlobal("window", target);
  const close = vi.fn();
  let handler: (() => void) | undefined;
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      set onmessage(value: () => void) {
        handler = value;
      }
      close = close;
    },
  );
  const changed = vi.fn();
  const dispose = listenSessionChanges(changed);
  target.dispatchEvent(new Event(SESSION_EVENT));
  target.dispatchEvent(new Event("pagehide"));
  for (const key of [
    SESSION_EVENT,
    "sb-offline-auth-token",
    "sb-offline-auth-token.0",
    null,
  ]) {
    const event = new Event("storage");
    Object.assign(event, { key });
    target.dispatchEvent(event);
  }
  handler?.();
  expect(changed).toHaveBeenCalledTimes(7);
  dispose();
  expect(close).toHaveBeenCalledOnce();
  expect(remove.mock.calls).toEqual(add.mock.calls);
  target.dispatchEvent(new Event(SESSION_EVENT));
  expect(changed).toHaveBeenCalledTimes(7);
});
