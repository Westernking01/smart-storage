import type { ProgressListener } from "./progress";
import { digest, wholeHash, finishHash, transform } from "./codec";
import { parseManifest, fail, type Block } from "./format";
export interface BlockTransport {
  open(
    block: Block,
    signal?: AbortSignal,
  ): Promise<{
    index: number;
    stream: ReadableStream<Uint8Array<ArrayBuffer>>;
  }>;
}
export interface RestoreSink {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  commit(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}
export async function restore(
  candidate: unknown,
  transport: BlockTransport,
  sink: RestoreSink,
  signal?: AbortSignal,
  onProgress?: (bytes: number) => void,
  onStage?: ProgressListener,
) {
  const whole = wholeHash();
  let originalBytes = 0,
    encodedBytes = 0,
    explicitBufferPeak = 0;
  try {
    const manifest = parseManifest(candidate);
    for (const block of manifest.blocks) {
      signal?.throwIfAborted();
      onStage?.({
        stage: "Downloading",
        bytes: encodedBytes,
        total: manifest.blocks.reduce((n, b) => n + b.encodedBytes, 0),
      });
      const response = await transport.open(block, signal);
      if (signal?.aborted) {
        await response.stream.cancel(signal.reason).catch(() => {});
        signal.throwIfAborted();
      }
      if (response.index !== block.index) {
        await response.stream.cancel().catch(() => {});
        fail("BLOCK_ORDER_MISMATCH");
      }
      const encoded = new Uint8Array(block.encodedBytes);
      const reader = response.stream.getReader();
      let length = 0;
      const cancel = () => {
        void reader.cancel(signal?.reason).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          signal?.throwIfAborted();
          const { value, done } = await reader.read();
          signal?.throwIfAborted();
          if (done) break;
          if (
            value.byteLength > 256 * 1024 ||
            length + value.length > encoded.length
          )
            fail("ENCODED_LENGTH_OR_CHUNK_LIMIT");
          explicitBufferPeak = Math.max(
            explicitBufferPeak,
            encoded.length + value.length,
          );
          encoded.set(value, length);
          length += value.length;
          onStage?.({
            stage: "Downloading",
            bytes: encodedBytes + length,
            total: manifest.blocks.reduce((n, b) => n + b.encodedBytes, 0),
          });
        }
      } catch (e) {
        await reader.cancel(e).catch(() => {});
        throw e;
      } finally {
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
      onStage?.({ stage: "Verifying" });
      if (
        length !== block.encodedBytes ||
        digest(encoded) !== block.encodedSha256
      )
        fail("ENCODED_INTEGRITY");
      onStage?.({
        stage: block.codec === "raw" ? "Verifying" : "Decompressing",
      });
      const original =
        block.codec === "raw"
          ? encoded
          : await transform(encoded, "decode", block.originalBytes, signal);
      explicitBufferPeak = Math.max(
        explicitBufferPeak,
        encoded.length +
          (original === encoded ? 0 : block.originalBytes) +
          256 * 1024,
      );
      if (
        original.length !== block.originalBytes ||
        digest(original) !== block.originalSha256
      )
        fail("ORIGINAL_BLOCK_INTEGRITY");
      for (let offset = 0; offset < original.length; offset += 65536) {
        signal?.throwIfAborted();
        const chunk = original.subarray(offset, offset + 65536);
        whole.update(chunk);
        await sink.write(chunk);
        originalBytes += chunk.length;
      }
      encodedBytes += encoded.length;
      signal?.throwIfAborted();
      onProgress?.(originalBytes);
    }
    signal?.throwIfAborted();
    if (
      originalBytes !== manifest.originalBytes ||
      finishHash(whole) !== manifest.originalSha256
    )
      fail("WHOLE_FILE_INTEGRITY");
    onStage?.({ stage: "Saving" });
    await sink.commit();
    signal?.throwIfAborted();
    return {
      verified: true as const,
      originalBytes,
      encodedBytes,
      explicitBufferPeak,
    };
  } catch (e) {
    await sink.abort(e).catch(() => {});
    throw e;
  } finally {
    whole.destroy();
  }
}
