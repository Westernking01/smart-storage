import { afterEach, expect, it, vi } from "vitest";
import { MemoryStore } from "../fixtures/memory-staging";
import { ScopedStaging } from "../../src/lib/transfers/scoped-store";
import { prepare } from "../../src/lib/transfers/prepare";
import {
  loadPreparedCloud,
  preparedCloudMetadata,
  stagePreparedCloud,
} from "../../src/lib/transfers/prepared-cloud";
import { uploadPreparedCloud } from "../../src/lib/transfers/cloud-client";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "99999999-9999-4999-8999-999999999999";
afterEach(() => vi.unstubAllGlobals());
async function fixture(source = new Blob(["compression first ".repeat(1000)])) {
  const memory = new MemoryStore();
  Object.assign(memory, {
    list: async () =>
      Promise.all([...memory.records.keys()].map((id) => memory.load(id))),
  });
  let current: string | null = owner;
  const store = new ScopedStaging(
    memory,
    { kind: "account", ownerId: owner },
    () => current,
  );
  const c = await prepare(source, store, undefined, undefined, undefined, {
    originalName: "original.txt",
    originalMime: "text/plain",
  });
  return {
    memory,
    store,
    c,
    switchOwner: () => {
      current = other;
    },
  };
}
it("persists restoration evidence and revalidates the existing encoded bytes without recompression", async () => {
  const f = await fixture();
  const encoded = await f.store.block(f.c.id, 0);
  expect(f.c.verifiedPreparation).toMatch(/^[a-f0-9]{64}$/);
  expect((await loadPreparedCloud(f.c.id, owner, f.store)).id).toBe(f.c.id);
  expect(await f.store.block(f.c.id, 0)).toBe(encoded);
});
it("rejects foreign-owner, unverified, incomplete and raw entries", async () => {
  const f = await fixture();
  expect(() => preparedCloudMetadata(f.c, other)).toThrow(
    "STAGING_OWNER_MISMATCH",
  );
  expect(() =>
    preparedCloudMetadata({ ...f.c, verifiedPreparation: undefined }, owner),
  ).toThrow("CLOUD_PREPARATION_UNVERIFIED");
  expect(() =>
    preparedCloudMetadata({ ...f.c, phase: "preparing" }, owner),
  ).toThrow("CLOUD_CHECKPOINT_BLOCKED");
  const raw = await fixture(new Blob([new Uint8Array([1, 2, 3])]));
  expect(() => preparedCloudMetadata(raw.c, owner)).toThrow(
    "CLOUD_COMPRESSED_FILE_REQUIRED",
  );
});
it("detects missing/corrupt staged bytes before any cloud request", async () => {
  const f = await fixture();
  const http = vi.fn();
  vi.stubGlobal("fetch", http);
  f.memory.blobs.set(`${f.c.id}/0`, new Blob(["damaged"]));
  await expect(
    uploadPreparedCloud(f.c, f.store, new AbortController().signal),
  ).rejects.toThrow();
  expect(http).not.toHaveBeenCalled();
  f.memory.blobs.clear();
  await expect(loadPreparedCloud(f.c.id, owner, f.store)).rejects.toThrow(
    "STAGED_DATA_MISSING",
  );
});
it("fences cancellation and account switching before transfer dispatch", async () => {
  const f = await fixture();
  const http = vi.fn();
  vi.stubGlobal("fetch", http);
  const abort = new AbortController();
  abort.abort();
  await expect(
    uploadPreparedCloud(f.c, f.store, abort.signal),
  ).rejects.toThrow();
  f.switchOwner();
  await expect(
    uploadPreparedCloud(f.c, f.store, new AbortController().signal),
  ).rejects.toThrow("STAGING_ACCOUNT_CHANGED");
  expect(http).not.toHaveBeenCalled();
});

it("hands off encoded bytes to project-scoped staging without changing original preparation or resetting progress", async () => {
  const f = await fixture();
  const memory = new MemoryStore();
  Object.assign(memory, {
    list: async () =>
      Promise.all([...memory.records.keys()].map((id) => memory.load(id))),
  });
  const target = new ScopedStaging(
    memory,
    { kind: "account", ownerId: owner },
    () => owner,
  );
  const copied = await stagePreparedCloud(
    f.c.id,
    owner,
    f.store,
    target,
    new AbortController().signal,
  );
  expect(copied.id).toBe(f.c.id);
  expect((await target.block(copied.id, 0)).size).toBe(
    (await f.store.block(f.c.id, 0)).size,
  );
  expect((await f.store.load(f.c.id)).revision).toBe(f.c.revision);
  const ambiguous = structuredClone(copied);
  ambiguous.revision++;
  ambiguous.phase = "ambiguous";
  ambiguous.blocks[0].phase = "ambiguous";
  ambiguous.blocks[0].attemptId = crypto.randomUUID();
  ambiguous.blocks[0].attemptedBytes = 1;
  await target.save(ambiguous, copied.revision);
  const retained = await stagePreparedCloud(
    f.c.id,
    owner,
    f.store,
    target,
    new AbortController().signal,
  );
  expect(retained).toEqual(ambiguous);
});
