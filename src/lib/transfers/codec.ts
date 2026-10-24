import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fail } from "./format";
export const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export const wholeHash = () => sha256.create();
export const finishHash = (hash: ReturnType<typeof wholeHash>) =>
  bytesToHex(hash.digest());
export async function sourceHash(source: Blob, signal?: AbortSignal) {
  const h = wholeHash();
  try {
    for (let offset = 0; offset < source.size; offset += 256 * 1024) {
      signal?.throwIfAborted();
      h.update(
        new Uint8Array(
          await source.slice(offset, offset + 256 * 1024).arrayBuffer(),
        ),
      );
      await new Promise((r) => setTimeout(r, 0));
    }
    signal?.throwIfAborted();
    return finishHash(h);
  } finally {
    h.destroy();
  }
}
export async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  mode: "encode" | "decode",
  cap: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  const capability =
    mode === "encode"
      ? globalThis.CompressionStream
      : globalThis.DecompressionStream;
  if (typeof capability !== "function") fail("CODEC_UNSUPPORTED");
  let cursor = 0;
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(c) {
      signal?.throwIfAborted();
      if (cursor === bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.subarray(cursor, cursor + 65536));
      cursor = Math.min(bytes.length, cursor + 65536);
    },
  });
  const reader = input
    .pipeThrough(new capability("gzip"), { signal })
    .getReader();
  const out = new Uint8Array(cap);
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > 256 * 1024 || length + value.length > cap)
        fail("CODEC_OUTPUT_LIMIT");
      out.set(value, length);
      length += value.length;
    }
    return out.subarray(0, length);
  } catch (e) {
    await reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}
export async function encodeBlock(
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
) {
  if (!bytes.length) return { codec: "raw" as const, bytes };
  try {
    return {
      codec: "gzip" as const,
      bytes: await transform(
        bytes,
        "encode",
        Math.floor(bytes.length * 0.98),
        signal,
      ),
    };
  } catch (e) {
    signal?.throwIfAborted();
    if (!(e instanceof Error) || e.message !== "CODEC_OUTPUT_LIMIT") throw e;
    return { codec: "raw" as const, bytes };
  }
}
