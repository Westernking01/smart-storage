import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  DEFAULT_BLOCK,
  MAX_FILE,
  check,
  decode,
  encode,
  hashInto,
  hex,
  indicators,
  observe,
  sampleRanges,
  transform,
  validateManifest,
  yieldTask,
  type Manifest,
} from "./core.js";

interface Request {
  id: number;
  method: string;
  args: Record<string, unknown>;
}
const scope = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: (event: MessageEvent<Request>) => void;
};
let active: AbortController | undefined;
let directory: FileSystemDirectoryHandle;
let manifest: Manifest | undefined;
let source: File | undefined;
const files = new Set<string>();
type IterableDirectory = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
};
async function init() {
  directory = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle("smart-storage-spike", { create: true });
  // Recover only this experiment's deterministic artifacts after forced termination.
  for await (const entry of (directory as IterableDirectory).values()) {
    if (/^(block-\d+|restored)$/.test(entry.name)) files.add(entry.name);
  }
  await cleanup();
}
async function remove(name: string) {
  await directory.removeEntry(name).catch((error: DOMException) => {
    if (error.name !== "NotFoundError") throw error;
  });
  files.delete(name);
}
async function cleanup() {
  for (const name of files) await remove(name);
  manifest = undefined;
  source = undefined;
}
async function write(name: string, bytes: Uint8Array<ArrayBuffer>) {
  files.add(name);
  const writable = await (
    await directory.getFileHandle(name, { create: true })
  ).createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}
async function read(name: string) {
  return (await directory.getFileHandle(name)).getFile();
}
async function prepare(
  file: File,
  blockSize: number,
  id: number,
  signal: AbortSignal,
  sinkDelay: number,
) {
  if (
    file.size > MAX_FILE ||
    blockSize > DEFAULT_BLOCK ||
    blockSize < 65536 ||
    !Number.isSafeInteger(blockSize)
  )
    throw Error("source/block limit");
  if (Math.ceil(file.size / blockSize) > 128) throw Error("descriptor limit");
  await cleanup();
  source = file;
  const m = indicators();
  const start = performance.now();
  const whole = sha256.create();
  const blocks: Manifest["blocks"] = [];
  let encodedPayload = 0;
  let offset = 0;
  try {
    for (
      let index = 0;
      index < Math.max(1, Math.ceil(file.size / blockSize));
      index++
    ) {
      check(signal);
      const bytes = new Uint8Array(
        await file.slice(offset, offset + blockSize).arrayBuffer(),
      );
      observe(m, bytes.byteLength);
      m.liveBlocksPeak = 1;
      const blockHash = sha256.create();
      await hashInto(bytes, [blockHash, whole], signal, m);
      const originalSha256 = bytesToHex(blockHash.digest());
      scope.postMessage({ id, event: "phase", phase: "compress", index });
      const encoded = await encode(bytes, signal, m);
      check(signal);
      const encodedHash = sha256.create();
      await hashInto(encoded.bytes, [encodedHash], signal, m);
      const descriptor = {
        index,
        offset,
        originalBytes: bytes.length,
        encodedBytes: encoded.bytes.length,
        codec: encoded.codec,
        originalSha256,
        encodedSha256: bytesToHex(encodedHash.digest()),
      };
      const sinkStart = performance.now();
      if (sinkDelay) {
        await new Promise((resolve) => setTimeout(resolve, sinkDelay));
        check(signal);
      }
      await write(`block-${index}`, encoded.bytes);
      check(signal);
      m.sinkMs += performance.now() - sinkStart;
      blocks.push(descriptor);
      offset += bytes.length;
      encodedPayload += encoded.bytes.length;
      scope.postMessage({
        id,
        event: "progress",
        phase: "prepare",
        originalBytes: offset,
        encodedBytes: encodedPayload,
        index,
      });
      await yieldTask(signal);
    }
    manifest = {
      format: "compression-spike",
      version: 1,
      blockSize,
      originalBytes: file.size,
      originalSha256: bytesToHex(whole.digest()),
      blocks,
    };
    validateManifest(manifest);
    return {
      manifest,
      encodedPayload,
      manifestOverhead: new TextEncoder().encode(JSON.stringify(manifest))
        .length,
      durationMs: performance.now() - start,
      indicators: m,
    };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    whole.destroy();
  }
}
async function restore(candidate: Manifest, id: number, signal: AbortSignal) {
  validateManifest(candidate);
  const m = indicators();
  const started = performance.now();
  const whole = sha256.create();
  const outName = "restored";
  files.add(outName);
  const out = await (
    await directory.getFileHandle(outName, { create: true })
  ).createWritable();
  let length = 0;
  try {
    for (const block of candidate.blocks) {
      check(signal);
      const stored = await read(`block-${block.index}`);
      if (stored.size !== block.encodedBytes) throw Error("encoded length");
      const bytes = new Uint8Array(await stored.arrayBuffer());
      const original = await decode(bytes, block, signal, m);
      check(signal);
      // Independently byte-compare bounded original slices, not just two shared hashes.
      if (source) {
        const expected = new Uint8Array(
          await source
            .slice(block.offset, block.offset + original.length)
            .arrayBuffer(),
        );
        observe(
          m,
          Array.from(
            new Set([bytes.buffer, original.buffer, expected.buffer]),
          ).reduce((sum, buffer) => sum + buffer.byteLength, 0),
        );
        for (let i = 0; i < original.length; i++)
          if (original[i] !== expected[i]) throw Error("source byte mismatch");
      }
      await hashInto(original, [whole], signal, m);
      const t = performance.now();
      await out.write(original);
      m.sinkMs += performance.now() - t;
      length += original.length;
      scope.postMessage({
        id,
        event: "progress",
        phase: "restore",
        originalBytes: length,
        index: block.index,
      });
    }
    const digest = bytesToHex(whole.digest());
    if (
      length !== candidate.originalBytes ||
      digest !== candidate.originalSha256
    )
      throw Error("whole-file integrity");
    check(signal);
    await out.close();
    return {
      verified: true,
      originalBytes: length,
      sha256: digest,
      exactBytes: true,
      durationMs: performance.now() - started,
      indicators: m,
    };
  } catch (error) {
    await out.abort().catch(() => {});
    await remove(outName);
    throw error;
  } finally {
    whole.destroy();
  }
}
async function sampling(file: File, signal: AbortSignal) {
  const m = indicators();
  const ranges = sampleRanges(file.size);
  let sampled = 0,
    encoded = 0;
  for (const [start, end] of ranges) {
    check(signal);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    const zipped = await transform(
      bytes,
      "compress",
      bytes.length + 1024,
      signal,
      m,
    );
    sampled += bytes.length;
    encoded += zipped.length;
  }
  const savings = sampled ? 1 - encoded / sampled : 0;
  return {
    ranges,
    sampledBytes: sampled,
    sampleEncodedBytes: encoded,
    estimatedSavings: savings,
    predictedAttempt: savings > 0.05,
    indicators: m,
  };
}
async function execute(req: Request, signal: AbortSignal): Promise<unknown> {
  const a = req.args;
  switch (req.method) {
    case "init":
      await init();
      return {
        compression: typeof CompressionStream === "function",
        decompression: typeof DecompressionStream === "function",
        worker: typeof document === "undefined",
        opfs: !!directory,
      };
    case "prepare":
      return prepare(
        a.file as File,
        a.blockSize as number,
        req.id,
        signal,
        Number(a.sinkDelay ?? 0),
      );
    case "restore":
      if (!manifest) throw Error("no manifest");
      return restore((a.manifest as Manifest) ?? manifest, req.id, signal);
    case "sample":
      return sampling(a.file as File, signal);
    case "vectors": {
      const results = [];
      for (const text of [
        "",
        "abc",
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      ]) {
        const state = sha256.create();
        const bytes = new TextEncoder().encode(text);
        for (const b of bytes) state.update(new Uint8Array([b]));
        results.push(bytesToHex(state.digest()));
        state.destroy();
      }
      const state = sha256.create();
      const thousand = new Uint8Array(1000).fill(97);
      for (let i = 0; i < 1000; i++) {
        state.update(thousand);
        if (i % 100 === 0) await yieldTask(signal);
      }
      results.push(bytesToHex(state.digest()));
      state.destroy();
      return results;
    }
    case "mutate": {
      if (!manifest) throw Error("no manifest");
      const index = Number(a.index ?? 0);
      const b = manifest.blocks[index];
      let bytes = new Uint8Array(
        await (await read(`block-${index}`)).arrayBuffer(),
      );
      if (a.truncate) bytes = bytes.slice(0, Math.max(0, bytes.length - 3));
      else bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      await write(`block-${index}`, bytes);
      if (a.rehash) {
        b.encodedBytes = bytes.length;
        b.encodedSha256 = hex(bytes);
      }
      return manifest;
    }
    case "drop":
      await remove(`block-${Number(a.index ?? 0)}`);
      return true;
    case "capture": {
      if (!manifest) throw Error("no manifest");
      const index = Number(a.index ?? 0);
      const f = await read(`block-${index}`);
      if (f.size > 256 * 1024) throw Error("capture safety cap");
      return {
        descriptor: manifest.blocks[index],
        bytes: Array.from(new Uint8Array(await f.arrayBuffer())),
      };
    }
    case "stats": {
      let count = 0;
      const names = [];
      for await (const entry of (directory as IterableDirectory).values()) {
        if (entry.kind === "file") {
          count++;
          names.push(entry.name);
        }
      }
      return { count, names };
    }
    case "cleanup":
      await cleanup();
      return true;
    default:
      throw Error("unknown method");
  }
}
scope.onmessage = (event) => {
  const req = event.data;
  if (req.method === "cancel") {
    active?.abort(new DOMException("Cancelled", "AbortError"));
    return;
  }
  if (req.method === "ping") {
    scope.postMessage({ id: req.id, result: req.args });
    return;
  }
  if (req.method === "transfer") {
    const bytes = req.args.buffer as ArrayBuffer;
    scope.postMessage(
      { id: req.id, result: { buffer: bytes, length: bytes.byteLength } },
      [bytes],
    );
    return;
  }
  if (active) {
    scope.postMessage({ id: req.id, error: "busy" });
    return;
  }
  const controller = new AbortController();
  active = controller;
  execute(req, controller.signal).then(
    (result) => {
      active = undefined;
      scope.postMessage({ id: req.id, result });
    },
    (error) => {
      active = undefined;
      scope.postMessage({
        id: req.id,
        error: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error",
      });
    },
  );
};
