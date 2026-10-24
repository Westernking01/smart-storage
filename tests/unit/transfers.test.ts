import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { prepare } from "@/lib/transfers/prepare";
import {
  restore,
  type RestoreSink,
  type BlockTransport,
} from "@/lib/transfers/restore";
import {
  upload,
  reconcileOffset,
  stopLocal,
  type UploadTransport,
} from "@/lib/transfers/upload";
import {
  envelope,
  openEnvelope,
  totals,
  recovery,
  validateTransition,
  type Checkpoint,
} from "@/lib/transfers/checkpoint";
import { attachmentName } from "@/lib/domain/file-metadata";
import { digest } from "@/lib/transfers/codec";
import {
  parseManifest,
  parseManifestBytes,
  BLOCK_BYTES,
  type Manifest,
} from "@/lib/transfers/format";
import { IndexedStaging, type StagingStore } from "@/lib/transfers/store";
import { validateManifest as legacyValidate } from "../../experiments/compression/core";
import { MemoryStore } from "../fixtures/memory-staging";
describe("checkpoint display metadata compatibility", () => {
  it("retains old envelopes without mutation and preserves original metadata on source reselection", async () => {
    const store = new MemoryStore();
    const source = new Blob(["metadata fixture"]);
    const old = await prepare(source, store);
    const stored = store.records.get(old.id)!;
    const restored = openEnvelope(stored);
    expect(restored.metadata).toBeUndefined();
    expect(envelope(restored)).toEqual(stored);
    expect(attachmentName(restored.metadata)).toBe("verified-restoration.bin");
    let id = "";
    const controller = new AbortController();
    const metadata = {
      originalName: "original.docx",
      originalMime: "application/octet-stream",
    };
    await expect(
      prepare(
        source,
        store,
        controller.signal,
        undefined,
        (c) => {
          id = c.id;
          controller.abort();
        },
        metadata,
      ),
    ).rejects.toThrow();
    const resumed = await prepare(source, store, undefined, id, undefined, {
      originalName: "reselected.bin",
      originalMime: null,
    });
    expect(resumed.metadata).toEqual(metadata);
    expect(openEnvelope(store.records.get(id)).metadata).toEqual(metadata);
    expect(() =>
      validateTransition(resumed, {
        ...resumed,
        revision: resumed.revision + 1,
        metadata: { ...metadata, originalName: "changed.bin" },
      }),
    ).toThrow("CHECKPOINT_TRANSITION_INVALID");
    expect(() =>
      validateTransition(resumed, {
        ...resumed,
        revision: resumed.revision + 1,
        displayName: "local-copy.docx",
      }),
    ).not.toThrow();
  });
});
function seededBytes(size: number) {
  const bytes = new Uint8Array(size);
  let seed = 0x12345678;
  for (let i = 0; i < size; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  return bytes;
}
function localTransport(store: StagingStore, id: string): BlockTransport {
  return {
    open: async (b) => ({
      index: b.index,
      stream: (await store.block(id, b.index)).stream(),
    }),
  };
}
function sink() {
  const h = createHash("sha256");
  let bytes = 0;
  const commit = vi.fn(async () => {}),
    abort = vi.fn(async () => {});
  return {
    target: {
      write: async (b: Uint8Array) => {
        h.update(b);
        bytes += b.length;
      },
      commit,
      abort,
    } satisfies RestoreSink,
    commit,
    abort,
    bytes: () => bytes,
    hash: () => h.digest("hex"),
  };
}
function remote(c: Checkpoint): UploadTransport {
  return {
    write: async (r) => ({ offset: r.offset + r.body.length }),
    verify: async (_id, i) => ({
      encodedBytes: c.blocks[i].block.encodedBytes,
      encodedSha256: c.blocks[i].block.encodedSha256,
    }),
    publish: async (_id, manifestSha256) => ({
      published: true,
      manifestSha256,
      originalSha256: c.sourceSha256,
    }),
  };
}
describe("reusable local staging and exact restoration", () => {
  it.each(["write", "publish"])(
    "does not dispatch %s after cancellation during durable intent persistence",
    async (stage) => {
      const store = new MemoryStore();
      const c = await prepare(new Blob([new Uint8Array(128)]), store);
      const controller = new AbortController();
      const save = store.save.bind(store);
      store.save = async (...args) => {
        await save(...args);
        const next = args[0];
        if (
          next.phase === "uploading" &&
          (stage === "write" ||
            next.blocks.every((b) => b.phase === "completed"))
        )
          controller.abort();
      };
      const transport = remote(c);
      const write = vi.fn(transport.write);
      const publish = vi.fn(transport.publish);
      transport.write = write;
      transport.publish = publish;
      await expect(
        upload(c.id, store, transport, controller.signal),
      ).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
      if (stage === "write") expect(write).not.toHaveBeenCalled();
      const durable = await store.load(c.id);
      expect(durable.phase).toBe(
        stage === "publish" ? "acknowledged" : "ambiguous",
      );
      if (stage === "publish")
        expect(durable.publication).toBe("cancelled-before-dispatch");
      else
        await expect(upload(c.id, store, transport)).rejects.toThrow(
          "UPLOAD_RECOVERY_REQUIRED",
        );
    },
  );
  it("cancels a stream returned after cancellation without reading or committing", async () => {
    const store = new MemoryStore();
    const c = await prepare(new Blob([new Uint8Array(128)]), store);
    const controller = new AbortController();
    const out = sink();
    const cancel = vi.fn();
    await expect(
      restore(
        c.manifest,
        {
          async open(block) {
            controller.abort();
            return {
              index: block.index,
              stream: new ReadableStream({ cancel }),
            };
          },
        },
        out.target,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(out.bytes()).toBe(0);
    expect(out.abort).toHaveBeenCalledOnce();
    expect(out.commit).not.toHaveBeenCalled();
  });
  it("cancellation during remote verification preserves acknowledged recovery state", async () => {
    const store = new MemoryStore();
    const c = await prepare(new Blob([new Uint8Array(128)]), store);
    const controller = new AbortController();
    const transport = remote(c);
    const verify = transport.verify;
    transport.verify = async (...args) => {
      controller.abort();
      return verify(...args);
    };
    const publish = vi.fn(transport.publish);
    transport.publish = publish;
    await expect(
      upload(c.id, store, transport, controller.signal),
    ).rejects.toThrow();
    const interrupted = await store.load(c.id);
    expect(interrupted.blocks[0].phase).toBe("acknowledged");
    expect(publish).not.toHaveBeenCalled();
    const resumed = remote(c);
    const write = vi.fn(resumed.write);
    resumed.write = write;
    expect((await upload(c.id, store, resumed)).phase).toBe("completed");
    expect(write).not.toHaveBeenCalled();
  });
  it("restores uploaded bytes after local staged blocks are removed (in-memory transport)", async () => {
    const store = new MemoryStore();
    const original = new TextEncoder().encode(
      "independent gzip fixture".repeat(1000),
    );
    const prepared = await prepare(new Blob([original]), store);
    expect(prepared.blocks[0].block.codec).toBe("gzip");
    const objects = new Map<number, Uint8Array<ArrayBuffer>>();
    let published = false;
    const transport: UploadTransport = {
      async write(request) {
        expect(request.id).toBe(prepared.id);
        expect(request.offset).toBe(objects.get(request.block)?.length ?? 0);
        const previous = objects.get(request.block) ?? new Uint8Array();
        const bytes = new Uint8Array(previous.length + request.body.length);
        bytes.set(previous);
        bytes.set(request.body, previous.length);
        objects.set(request.block, bytes);
        return { offset: bytes.length };
      },
      async verify(_id, index) {
        const bytes = objects.get(index)!;
        return { encodedBytes: bytes.length, encodedSha256: digest(bytes) };
      },
      async publish(_id, manifestSha256) {
        expect(
          (await store.load(prepared.id)).blocks.every(
            (block) => block.phase === "completed",
          ),
        ).toBe(true);
        published = true;
        return {
          published: true,
          manifestSha256,
          originalSha256: prepared.sourceSha256,
        };
      },
    };
    const completed = await upload(prepared.id, store, transport);
    expect(completed.phase).toBe("completed");
    expect(published).toBe(true);
    store.blobs.clear();
    const out = sink();
    const downloaded = vi.fn<BlockTransport["open"]>(async (block) => ({
      index: block.index,
      stream: new Blob([objects.get(block.index)!]).stream(),
    }));
    const result = await restore(
      completed.manifest,
      { open: downloaded },
      out.target,
    );
    expect(downloaded).toHaveBeenCalledTimes(completed.blocks.length);
    expect(result.verified).toBe(true);
    expect(out.bytes()).toBe(original.length);
    expect(out.hash()).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    expect(out.commit).toHaveBeenCalledOnce();
    expect(out.abort).not.toHaveBeenCalled();
  });
  it("bounded manifest bytes reject oversized or invalid UTF-8 input", () => {
    expect(() => parseManifestBytes(new Uint8Array(128 * 1024 + 1))).toThrow(
      "MANIFEST_LIMIT",
    );
    expect(() => parseManifestBytes(new Uint8Array([255]))).toThrow();
  });
  it("interrupted preparation resumes with reselected source and exact restaging", async () => {
    const store = new MemoryStore(),
      source = new Blob([new Uint8Array(BLOCK_BYTES + 128).fill(65)]),
      abort = new AbortController();
    let id = "";
    await expect(
      prepare(source, store, abort.signal, undefined, (c) => {
        id = c.id;
        if (c.blocks.length === 1) abort.abort();
      }),
    ).rejects.toThrow();
    const previous = await store.load(id);
    expect(previous.phase).toBe("preparing");
    store.blobs.clear();
    const recovered = await prepare(source, store, undefined, id);
    expect(recovered.id).toBe(id);
    expect(recovered.blocks[0].block).toEqual(previous.blocks[0].block);
    expect(recovered.blocks).toHaveLength(2);
    const out = sink();
    await restore(recovered.manifest, localTransport(store, id), out.target);
    expect(out.bytes()).toBe(source.size);
  }, 20000);
  it("revision conflict and counter/descriptor rewrites are rejected", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([new Uint8Array(128)]), store);
    const successor = structuredClone(c);
    successor.revision++;
    successor.phase = "cancelled";
    await store.save(successor, c.revision);
    await expect(store.save(successor, c.revision)).rejects.toThrow(
      "CHECKPOINT_CONFLICT",
    );
    const forged = structuredClone(successor);
    forged.revision++;
    forged.blocks[0].block.originalSha256 = "0".repeat(64);
    expect(() => validateTransition(successor, forged)).toThrow(
      "CHECKPOINT_TRANSITION_INVALID",
    );
  });
  it("oversized decompression output and unknown codecs never commit", async () => {
    const original = new Uint8Array(10000).fill(65),
      encoded = Uint8Array.from(gzipSync(original));
    const manifest: Manifest = {
      format: "compression-spike",
      version: 1,
      blockSize: BLOCK_BYTES,
      originalBytes: 100,
      originalSha256: digest(original.subarray(0, 100)),
      blocks: [
        {
          index: 0,
          offset: 0,
          originalBytes: 100,
          encodedBytes: encoded.length,
          codec: "gzip",
          originalSha256: digest(original.subarray(0, 100)),
          encodedSha256: digest(encoded),
        },
      ],
    };
    const out = sink();
    await expect(
      restore(
        manifest,
        {
          open: async () => ({
            index: 0,
            stream: new Blob([encoded]).stream(),
          }),
        },
        out.target,
      ),
    ).rejects.toThrow("CODEC_OUTPUT_LIMIT");
    expect(out.commit).not.toHaveBeenCalled();
    expect(() =>
      parseManifest({
        ...manifest,
        blocks: [{ ...manifest.blocks[0], codec: "brotli" }],
      }),
    ).toThrow();
  });
  it("unsupported codec and aborted blocked stream propagate safely", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([new Uint8Array(128)]), store),
      out = sink(),
      abort = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const job = restore(
      c.manifest,
      {
        open: async () => {
          entered();
          return {
            index: 0,
            stream: new ReadableStream<Uint8Array<ArrayBuffer>>(),
          };
        },
      },
      out.target,
      abort.signal,
    );
    await ready;
    abort.abort();
    await expect(job).rejects.toThrow();
    expect(out.abort).toHaveBeenCalledOnce();
    expect(out.commit).not.toHaveBeenCalled();
    vi.stubGlobal("DecompressionStream", undefined);
    try {
      await expect(
        restore(c.manifest, localTransport(store, c.id), sink().target),
      ).rejects.toThrow("CODEC_UNSUPPORTED");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([0, 1, 127, 1024 * 1024, 2 * BLOCK_BYTES + 37])(
    "round trips %i bytes without collecting output",
    async (size) => {
      const input = new Uint8Array(size).fill(65),
        store = new MemoryStore();
      const c = await prepare(new Blob([input]), store),
        out = sink();
      legacyValidate(c.manifest!);
      const result = await restore(
        c.manifest,
        localTransport(store, c.id),
        out.target,
      );
      expect(result.verified).toBe(true);
      expect(out.bytes()).toBe(size);
      expect(out.hash()).toBe(createHash("sha256").update(input).digest("hex"));
      expect(result.explicitBufferPeak).toBeLessThanOrEqual(
        2 * BLOCK_BYTES + 256 * 1024,
      );
      expect(out.commit).toHaveBeenCalledOnce();
      expect(out.abort).not.toHaveBeenCalled();
      expect(totals(c).uploadedBytes).toBe(0);
    },
    20000,
  );
  it("incompressible raw data retains exact encoded bytes", async () => {
    const store = new MemoryStore(),
      input = seededBytes(128 * 1024);
    const c = await prepare(new Blob([input]), store);
    expect(c.blocks[0].block.codec).toBe("raw");
    const out = sink();
    await restore(c.manifest, localTransport(store, c.id), out.target);
    expect(out.hash()).toBe(digest(input));
  });
  it("recovery preserves acknowledged blocks and does not replay ambiguous writes", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([seededBytes(8 * 1024 * 1024 + 33)]), store);
    let calls = 0;
    const transport = remote(c);
    transport.write = async (r) => {
      calls++;
      if (calls === 2) throw Error("ACK_LOST");
      return { offset: r.offset + r.body.length };
    };
    await expect(upload(c.id, store, transport)).rejects.toThrow("ACK_LOST");
    const interrupted = await store.load(c.id);
    expect(recovery(interrupted).requiresRemoteReconciliation).toBe(true);
    expect(totals(interrupted).uploadedBytes).toBe(6 * 1024 * 1024);
    expect(totals(interrupted).attemptedTransferBytes).toBe(8 * 1024 * 1024);
    await expect(upload(c.id, store, transport)).rejects.toThrow(
      "UPLOAD_RECOVERY_REQUIRED",
    );
    expect(calls).toBe(2);
    await reconcileOffset(c.id, 0, 8 * 1024 * 1024, store); // Explicit read-only offset evidence; content proof still required.
    await upload(c.id, store, transport);
    expect(calls).toBe(3);
    expect((await store.load(c.id)).phase).toBe("completed");
  }, 20000);
  it("remote offset does not replace block integrity or publication evidence", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([new Uint8Array(128)]), store),
      transport = remote(c);
    transport.verify = async () => ({
      encodedBytes: 0,
      encodedSha256: "0".repeat(64),
    });
    await expect(upload(c.id, store, transport)).rejects.toThrow(
      "REMOTE_BLOCK_INTEGRITY",
    );
    expect((await store.load(c.id)).phase).not.toBe("completed");
  });
  it("lost publication acknowledgement cannot be silently republished", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([new Uint8Array(128)]), store),
      transport = remote(c);
    const publish = vi.fn(async () => {
      throw Error("PUBLISH_ACK_LOST");
    });
    transport.publish = publish;
    await expect(upload(c.id, store, transport)).rejects.toThrow(
      "PUBLISH_ACK_LOST",
    );
    await expect(upload(c.id, store, transport)).rejects.toThrow(
      "UPLOAD_RECOVERY_REQUIRED",
    );
    expect(publish).toHaveBeenCalledOnce();
  });
  it("missing stages, invalid manifests and corrupted checkpoints fail closed", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([new Uint8Array(128)]), store);
    const r = store.records.get(c.id)!;
    r.text = r.text.replace('"revision":2', '"revision":9');
    expect(() => openEnvelope(r)).toThrow();
    store.blobs.clear();
    const out = sink();
    await expect(
      restore(c.manifest, localTransport(store, c.id), out.target),
    ).rejects.toThrow("STAGED_DATA_MISSING");
    expect(out.commit).not.toHaveBeenCalled();
    for (const m of [
      { ...c.manifest, version: 2 },
      { ...c.manifest, blocks: [] },
      { ...c.manifest, blocks: [c.blocks[0].block, c.blocks[0].block] },
    ])
      expect(() => parseManifest(m)).toThrow();
  });
  it.each([
    "truncated",
    "encoded-corrupt",
    "gzip-corrupt",
    "wrong-whole",
    "reordered",
  ])("rejects %s restoration and aborts partial output", async (kind) => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([new Uint8Array(100000).fill(65)]), store),
      m = structuredClone(c.manifest!),
      original = await store.block(c.id, 0);
    let bytes = new Uint8Array(await original.arrayBuffer());
    if (kind === "truncated") bytes = bytes.slice(0, -1);
    if (kind === "encoded-corrupt" || kind === "gzip-corrupt")
      bytes[bytes.length >> 1] ^= 255;
    if (kind === "gzip-corrupt") m.blocks[0].encodedSha256 = digest(bytes);
    if (kind === "wrong-whole") m.originalSha256 = "0".repeat(64);
    const out = sink();
    await expect(
      restore(
        m,
        {
          open: async () => ({
            index: kind === "reordered" ? 1 : 0,
            stream: new Blob([bytes]).stream(),
          }),
        },
        out.target,
      ),
    ).rejects.toThrow();
    expect(out.abort).toHaveBeenCalledOnce();
    expect(out.commit).not.toHaveBeenCalled();
  });
  it("sink backpressure prevents opening the next block", async () => {
    const store = new MemoryStore(),
      c = await prepare(
        new Blob([new Uint8Array(BLOCK_BYTES + 1).fill(65)]),
        store,
      );
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const blocked = new Promise<void>((r) => {
      entered = r;
    });
    const open = vi.fn(localTransport(store, c.id).open);
    let first = true;
    const target: RestoreSink = {
      write: async () => {
        if (first) {
          first = false;
          entered();
          await wait;
        }
      },
      commit: async () => {},
      abort: async () => {},
    };
    const job = restore(c.manifest, { open }, target);
    await blocked;
    expect(open).toHaveBeenCalledTimes(1);
    release();
    await job;
    expect(open).toHaveBeenCalledTimes(2);
  }, 20000);
  it("cancelled download and upload never fabricate completion", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([new Uint8Array(100000)]), store),
      controller = new AbortController(),
      out = sink();
    out.target.write = async () => {
      controller.abort();
    };
    await expect(
      restore(
        c.manifest,
        localTransport(store, c.id),
        out.target,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(out.commit).not.toHaveBeenCalled();
    const a = new AbortController(),
      transport = remote(c);
    transport.write = async (r) => {
      a.abort();
      return { offset: r.body.length };
    };
    await expect(upload(c.id, store, transport, a.signal)).rejects.toThrow();
    expect((await store.load(c.id)).phase).toBe("ambiguous");
  });
  it("quota failure leaves durable preparation recoverable, source mismatch rejected", async () => {
    const store = new MemoryStore();
    store.quota = 0;
    await expect(
      prepare(new Blob([new Uint8Array(128)]), store),
    ).rejects.toThrow("STAGING_QUOTA_EXCEEDED");
    const id = [...store.records.keys()][0];
    expect((await store.load(id)).phase).toBe("preparing");
    store.quota = Infinity;
    await expect(
      prepare(new Blob([new Uint8Array(128).fill(1)]), store, undefined, id),
    ).rejects.toThrow("SOURCE_CHANGED");
    expect(
      (await prepare(new Blob([new Uint8Array(128)]), store, undefined, id))
        .phase,
    ).toBe("prepared");
  });
  it("local cancellation retains counters and unsupported staging fails explicitly", async () => {
    const store = new MemoryStore(),
      c = await prepare(new Blob([]), store);
    const stopped = await stopLocal(c.id, store);
    expect(stopped.phase).toBe("cancelled");
    expect(totals(stopped).attemptedTransferBytes).toBe(0);
    await expect(IndexedStaging.open("fixture", undefined)).rejects.toThrow(
      "STAGING_UNSUPPORTED",
    );
  });
  it("independent gzip fixture from Node restores through browser-compatible decoder", async () => {
    const original = new TextEncoder().encode(
        "independent gzip fixture".repeat(1000),
      ),
      encoded = Uint8Array.from(gzipSync(original));
    const manifest: Manifest = {
      format: "compression-spike",
      version: 1,
      blockSize: BLOCK_BYTES,
      originalBytes: original.length,
      originalSha256: digest(original),
      blocks: [
        {
          index: 0,
          offset: 0,
          originalBytes: original.length,
          encodedBytes: encoded.length,
          codec: "gzip",
          originalSha256: digest(original),
          encodedSha256: digest(encoded),
        },
      ],
    };
    const out = sink();
    await restore(
      manifest,
      {
        open: async () => ({ index: 0, stream: new Blob([encoded]).stream() }),
      },
      out.target,
    );
    expect(out.hash()).toBe(digest(original));
  });
});
