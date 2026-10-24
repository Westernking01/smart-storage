import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Experimental numeric descriptors; intentionally NOT the production manifest v1.
export const MIB = 1024 * 1024;
export const DEFAULT_BLOCK = 8 * MIB;
export const MAX_FILE = 32 * MIB; // Harness safety ceiling, not a product limit.
export const SAMPLE_RANGE = 64 * 1024;
export const SAMPLE_CAP = 4 * SAMPLE_RANGE;
export interface Block {
  index: number;
  offset: number;
  originalBytes: number;
  encodedBytes: number;
  codec: "gzip" | "raw";
  originalSha256: string;
  encodedSha256: string;
}
export interface Manifest {
  format: "compression-spike";
  version: 1;
  blockSize: number;
  originalBytes: number;
  originalSha256: string;
  blocks: Block[];
}
export interface Indicators {
  trackedBufferPeak: number;
  codecChunkPeak: number;
  heapSamples: number[];
  hashMs: number;
  codecMs: number;
  sinkMs: number;
  candidateAborts: number;
  liveBlocksPeak: number;
}
export function indicators(): Indicators {
  return {
    trackedBufferPeak: 0,
    codecChunkPeak: 0,
    heapSamples: [],
    hashMs: 0,
    codecMs: 0,
    sinkMs: 0,
    candidateAborts: 0,
    liveBlocksPeak: 0,
  };
}
export function observe(m: Indicators, live: number) {
  m.trackedBufferPeak = Math.max(m.trackedBufferPeak, live);
  const p = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  if (p.memory && m.heapSamples.length < 128)
    m.heapSamples.push(p.memory.usedJSHeapSize);
}
export function check(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
export async function yieldTask(signal?: AbortSignal) {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  check(signal);
}
export const hex = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export async function hashInto(
  bytes: Uint8Array,
  states: ReturnType<typeof sha256.create>[],
  signal: AbortSignal,
  m: Indicators,
) {
  for (let start = 0; start < bytes.length; start += 256 * 1024) {
    check(signal);
    const t = performance.now();
    for (const state of states)
      state.update(bytes.subarray(start, start + 256 * 1024));
    m.hashMs += performance.now() - t;
    await yieldTask(signal);
  }
}
export function sampleRanges(size: number): [number, number][] {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE)
    throw Error("source limit");
  if (size <= SAMPLE_CAP) return size ? [[0, size]] : [];
  return [0, 1, 2, 3].map((i) => {
    const start = Math.floor((i * (size - SAMPLE_RANGE)) / 3);
    return [start, start + SAMPLE_RANGE];
  });
}
export function useGzip(original: number, encoded: number) {
  return original > 0 && encoded <= Math.floor(original * 0.98);
}
class OutputLimit extends Error {}

// Pulls 64 KiB views, holds a capped candidate, never gathers unbounded chunks.
export async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  codec: "compress" | "decompress",
  cap: number,
  signal: AbortSignal,
  m: Indicators,
) {
  check(signal);
  const output = new Uint8Array(cap);
  observe(m, bytes.byteLength + output.byteLength);
  let cursor = 0;
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      check(signal);
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(cursor, cursor + SAMPLE_RANGE));
      cursor += SAMPLE_RANGE;
    },
  });
  const stream =
    codec === "compress"
      ? new CompressionStream("gzip")
      : new DecompressionStream("gzip");
  const reader = input.pipeThrough(stream, { signal }).getReader();
  let length = 0;
  const started = performance.now();
  try {
    while (true) {
      check(signal);
      const { value, done } = await reader.read();
      if (done) break;
      m.codecChunkPeak = Math.max(m.codecChunkPeak, value.byteLength);
      observe(m, bytes.byteLength + output.byteLength + value.byteLength);
      if (length + value.length > cap)
        throw new OutputLimit("decoded/candidate output limit");
      output.set(value, length);
      length += value.length;
    }
    return output.subarray(0, length);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    m.codecMs += performance.now() - started;
  }
}
export async function encode(
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  m: Indicators,
) {
  if (!bytes.length) return { codec: "raw" as const, bytes };
  try {
    const candidate = await transform(
      bytes,
      "compress",
      Math.floor(bytes.length * 0.98),
      signal,
      m,
    );
    return { codec: "gzip" as const, bytes: candidate };
  } catch (error) {
    check(signal);
    if (!(error instanceof OutputLimit)) throw error;
    m.candidateAborts++;
    return { codec: "raw" as const, bytes };
  }
}
export function validateManifest(manifest: Manifest) {
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const hash = (s: string) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  if (
    !manifest ||
    manifest.format !== "compression-spike" ||
    manifest.version !== 1 ||
    !integer(manifest.originalBytes) ||
    manifest.originalBytes > MAX_FILE ||
    !integer(manifest.blockSize) ||
    manifest.blockSize < SAMPLE_RANGE ||
    manifest.blockSize > DEFAULT_BLOCK ||
    !hash(manifest.originalSha256) ||
    !Array.isArray(manifest.blocks) ||
    manifest.blocks.length < 1 ||
    manifest.blocks.length > 128 ||
    new TextEncoder().encode(JSON.stringify(manifest)).length > 128 * 1024
  )
    throw Error("manifest limit/version");
  if (
    manifest.blocks.length !==
    Math.max(1, Math.ceil(manifest.originalBytes / manifest.blockSize))
  )
    throw Error("missing block/count");
  let offset = 0;
  manifest.blocks.forEach((b, index) => {
    const expected = Math.min(
      manifest.blockSize,
      manifest.originalBytes - offset,
    );
    if (
      !b ||
      b.index !== index ||
      b.offset !== offset ||
      b.originalBytes !== expected ||
      !integer(b.encodedBytes) ||
      b.encodedBytes > manifest.blockSize ||
      !hash(b.originalSha256) ||
      !hash(b.encodedSha256) ||
      !["gzip", "raw"].includes(b.codec) ||
      (b.codec === "raw" && b.encodedBytes !== b.originalBytes) ||
      (b.codec === "gzip" && (b.encodedBytes < 18 || !b.originalBytes))
    )
      throw Error("block order/length/codec");
    offset += b.originalBytes;
  });
  if (offset !== manifest.originalBytes) throw Error("whole length");
}
export async function decode(
  bytes: Uint8Array<ArrayBuffer>,
  block: Block,
  signal: AbortSignal,
  m: Indicators,
) {
  if (bytes.length !== block.encodedBytes || hex(bytes) !== block.encodedSha256)
    throw Error("encoded integrity");
  const original =
    block.codec === "raw"
      ? bytes
      : await transform(bytes, "decompress", block.originalBytes, signal, m);
  if (
    original.length !== block.originalBytes ||
    hex(original) !== block.originalSha256
  )
    throw Error("original integrity");
  return original;
}
