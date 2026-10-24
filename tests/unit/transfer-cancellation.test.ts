import { afterEach, expect, it, vi } from "vitest";
import { transform } from "@/lib/transfers/codec";
import { prepare } from "@/lib/transfers/prepare";
import { restore } from "@/lib/transfers/restore";
import { uploadPreparedCloud } from "@/lib/transfers/cloud-client";
import { ScopedStaging } from "@/lib/transfers/scoped-store";
import { MemoryStore } from "../fixtures/memory-staging";

afterEach(() => vi.unstubAllGlobals());
it.each(["encode", "decode"] as const)(
  "rejects cancellation at %s completion rather than accepting late bytes",
  async (mode) => {
    const controller = new AbortController();
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, output) {
        output.enqueue(bytes);
      },
      flush() {
        controller.abort();
      },
    });
    vi.stubGlobal(
      mode === "encode" ? "CompressionStream" : "DecompressionStream",
      class {
        constructor() {
          return stream;
        }
      },
    );
    await expect(
      transform(new Uint8Array([1]), mode, 100, controller.signal),
    ).rejects.toThrow();
  },
);

it("does not emit preparation progress after cancellation during a staging save", async () => {
  const store = new MemoryStore();
  const controller = new AbortController();
  const save = store.save.bind(store);
  store.save = async (...args) => {
    await save(...args);
    controller.abort();
  };
  const progress = vi.fn();
  await expect(
    prepare(
      new Blob(["fixture"]),
      store,
      controller.signal,
      undefined,
      progress,
    ),
  ).rejects.toThrow();
  expect(progress).not.toHaveBeenCalled();
});

it("does not emit restore progress or commit after cancellation during output write", async () => {
  const store = new MemoryStore();
  const checkpoint = await prepare(new Blob(["fixture"]), store);
  const controller = new AbortController();
  const progress = vi.fn();
  const sink = {
    write: async () => {
      controller.abort();
    },
    commit: vi.fn(),
    abort: vi.fn(),
  };
  await expect(
    restore(
      checkpoint.manifest,
      {
        open: async (b) => ({
          index: b.index,
          stream: (await store.block(checkpoint.id, b.index)).stream(),
        }),
      },
      sink,
      controller.signal,
      progress,
    ),
  ).rejects.toThrow();
  expect(progress).not.toHaveBeenCalled();
  expect(sink.commit).not.toHaveBeenCalled();
  expect(sink.abort).toHaveBeenCalledOnce();
});

it("does not return a verified result if cancellation occurs during sink commit", async () => {
  const store = new MemoryStore();
  const checkpoint = await prepare(new Blob(["fixture"]), store);
  const controller = new AbortController();
  const abort = vi.fn();
  await expect(
    restore(
      checkpoint.manifest,
      {
        open: async (block) => ({
          index: block.index,
          stream: (await store.block(checkpoint.id, block.index)).stream(),
        }),
      },
      {
        write: async () => {},
        commit: async () => {
          controller.abort();
        },
        abort,
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(abort).toHaveBeenCalledOnce();
});

it("denies a foreign checkpoint before begin or receipt dispatch", async () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const memory = new MemoryStore();
  const own = new ScopedStaging(
    memory,
    { kind: "account", ownerId: A },
    () => A,
  );
  const checkpoint = await prepare(new Blob(["fixture"]), own);
  const other = new ScopedStaging(
    memory,
    { kind: "account", ownerId: B },
    () => B,
  );
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const phase of ["prepared", "completed"] as const) {
    await expect(
      uploadPreparedCloud(
        { ...checkpoint, phase },
        other,
        new AbortController().signal,
      ),
    ).rejects.toThrow("STAGING_OWNER_MISMATCH");
  }
  expect(fetch).not.toHaveBeenCalled();
});
