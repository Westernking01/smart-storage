import { expect, it, vi } from "vitest";
import { cleanupPublishedLocal } from "../../src/lib/transfers/published-local-cleanup";
import { localDestination } from "../../src/lib/transfers/sinks";
import { prepare } from "../../src/lib/transfers/prepare";
import { MemoryStore } from "../fixtures/memory-staging";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function fixture() {
  const store = new MemoryStore();
  const c = await prepare(new Blob(["fixture ".repeat(1000)]), store);
  c.ownerId = owner;
  c.phase = "completed";
  const release = vi.fn(async () => {});
  const target = {
    load: vi.fn(async () => c),
    block: store.block.bind(store),
    save: store.save.bind(store),
    releasePublishedPayload: release,
  };
  const source = {
    ...target,
    list: vi.fn(async () => [c]),
    releasePublishedPayload: vi.fn(async () => {}),
  };
  return { c, target, source, release };
}
it("cleans only after durable matching publication and touches no remote interface", async () => {
  const { c, target, source, release } = await fixture();
  await cleanupPublishedLocal(
    c,
    target,
    source,
    owner,
    new AbortController().signal,
  );
  expect(release).toHaveBeenCalledOnce();
  expect(source.releasePublishedPayload).toHaveBeenCalledWith(c);
});
it.each(["prepared", "ambiguous", "cancelled", "failed"] as const)(
  "retains %s payloads",
  async (phase) => {
    const { c, target, source, release } = await fixture();
    c.phase = phase;
    await expect(
      cleanupPublishedLocal(
        c,
        target,
        source,
        owner,
        new AbortController().signal,
      ),
    ).rejects.toThrow("LOCAL_DISCARD_UNSAFE");
    expect(release).not.toHaveBeenCalled();
    expect(source.releasePublishedPayload).not.toHaveBeenCalled();
  },
);
it("rejects cross-owner cleanup and aborted sessions", async () => {
  const { c, target, source, release } = await fixture();
  await expect(
    cleanupPublishedLocal(
      c,
      target,
      source,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(
    cleanupPublishedLocal(c, target, source, owner, abort.signal),
  ).rejects.toThrow();
  expect(release).not.toHaveBeenCalled();
});
it("retains target payload on source cleanup failure for local-only continuation", async () => {
  const { c, target, source, release } = await fixture();
  source.releasePublishedPayload.mockRejectedValueOnce(
    Error("LOCAL_CLEANUP_PENDING"),
  );
  await expect(
    cleanupPublishedLocal(
      c,
      target,
      source,
      owner,
      new AbortController().signal,
    ),
  ).rejects.toThrow("LOCAL_CLEANUP_PENDING");
  expect(release).not.toHaveBeenCalled();
});
it("bounds fallback retention and denies access before verified commit or after discard", async () => {
  vi.stubGlobal("navigator", {});
  try {
    const dest = await localDestination("fixture", owner, 4);
    await expect(dest.file()).rejects.toThrow("RESTORATION_NOT_VERIFIED");
    await dest.sink.write(new Uint8Array([1, 2, 3]));
    await expect(dest.sink.write(new Uint8Array([4, 5]))).rejects.toThrow(
      "RESTORED_SIZE_LIMIT",
    );
    await dest.sink.commit();
    expect(new Uint8Array(await (await dest.file()).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await dest.remove();
    await expect(dest.file()).rejects.toThrow("RESTORATION_NOT_VERIFIED");
  } finally {
    vi.unstubAllGlobals();
  }
});
