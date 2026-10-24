import {
  BLOCK_BYTES,
  FILE_BYTES,
  fail,
  parseManifest,
  type Manifest,
} from "./format";
import {
  digest,
  encodeBlock,
  sourceHash,
  wholeHash,
  finishHash,
} from "./codec";
import type { Checkpoint } from "./checkpoint";
import type { StagingStore } from "./store";
import { manifestIdentity, verifyStagedPreparation } from "./prepared-cloud";
import { parseFileMetadata, type FileMetadata } from "../domain/file-metadata";
export async function prepare(
  source: Blob,
  store: StagingStore,
  signal?: AbortSignal,
  existingId?: string,
  onProgress?: (c: Checkpoint) => void,
  metadata?: FileMetadata,
): Promise<Checkpoint> {
  const displayMetadata =
    metadata === undefined ? undefined : parseFileMetadata(metadata);
  if (source.size > FILE_BYTES) fail("LOCAL_FILE_LIMIT");
  signal?.throwIfAborted();
  // Entire-source identity prepass is streamed; filename/mtime are not evidence.
  const hash = await sourceHash(source, signal);
  const verifiedSource = wholeHash();
  try {
    let c: Checkpoint;
    if (existingId) {
      c = await store.load(existingId);
      if (c.sourceSha256 !== hash || c.originalBytes !== source.size)
        fail("SOURCE_CHANGED");
      if (c.phase !== "preparing") fail("PREPARATION_NOT_RESUMABLE");
      for (const p of c.blocks) {
        const original = new Uint8Array(
          await source
            .slice(p.block.offset, p.block.offset + p.block.originalBytes)
            .arrayBuffer(),
        );
        if (digest(original) !== p.block.originalSha256) fail("SOURCE_CHANGED");
        verifiedSource.update(original);
        let staged: Blob;
        try {
          staged = await store.block(c.id, p.block.index);
        } catch (e) {
          if (!(e instanceof Error) || e.message !== "STAGED_DATA_MISSING")
            throw e;
          const regenerated = await encodeBlock(original, signal);
          if (
            regenerated.codec !== p.block.codec ||
            regenerated.bytes.length !== p.block.encodedBytes ||
            digest(regenerated.bytes) !== p.block.encodedSha256
          )
            fail("RESTAGING_BYTES_CHANGED");
          staged = new Blob([regenerated.bytes]);
          const next = { ...c, revision: c.revision + 1 };
          await store.save(next, c.revision, {
            index: p.block.index,
            blob: staged,
          });
          c = next;
        }
        if (
          staged.size !== p.block.encodedBytes ||
          (await sourceHash(staged, signal)) !== p.block.encodedSha256
        )
          fail("STAGED_INTEGRITY");
      }
    } else {
      c = {
        version: 1,
        id: crypto.randomUUID(),
        revision: 0,
        originalBytes: source.size,
        sourceSha256: hash,
        blockSize: BLOCK_BYTES,
        phase: "preparing",
        blocks: [],
        manifest: null,
        ...(displayMetadata ? { metadata: displayMetadata } : {}),
        ...(displayMetadata
          ? { displayName: displayMetadata.originalName }
          : {}),
        createdAt: new Date().toISOString(),
      };
      await store.save(c, null);
    }
    signal?.throwIfAborted();
    onProgress?.(structuredClone(c));
    const count = Math.max(1, Math.ceil(source.size / c.blockSize));
    for (let index = c.blocks.length; index < count; index++) {
      signal?.throwIfAborted();
      const offset = index * c.blockSize;
      const original = new Uint8Array(
        await source.slice(offset, offset + c.blockSize).arrayBuffer(),
      );
      verifiedSource.update(original);
      const encoded = await encodeBlock(original, signal);
      signal?.throwIfAborted();
      const next = structuredClone(c);
      next.revision++;
      next.blocks.push({
        block: {
          index,
          offset,
          originalBytes: original.length,
          encodedBytes: encoded.bytes.length,
          codec: encoded.codec,
          originalSha256: digest(original),
          encodedSha256: digest(encoded.bytes),
        },
        phase: "prepared",
        acknowledgedBytes: 0,
        attemptedBytes: 0,
        attemptId: null,
      });
      await store.save(next, c.revision, {
        index,
        blob: new Blob([encoded.bytes]),
      });
      c = next;
      signal?.throwIfAborted();
      onProgress?.(structuredClone(c));
    }
    signal?.throwIfAborted();
    if (finishHash(verifiedSource) !== hash)
      fail("SOURCE_CHANGED_DURING_PREPARATION");
    const manifest: Manifest = {
      format: "compression-spike",
      version: 1,
      blockSize: c.blockSize,
      originalBytes: c.originalBytes,
      originalSha256: c.sourceSha256,
      blocks: c.blocks.map((p) => p.block),
    };
    parseManifest(manifest);
    const next = {
      ...c,
      revision: c.revision + 1,
      phase: "prepared" as const,
      manifest,
    };
    await verifyStagedPreparation(next, store, signal);
    const verified = { ...next, verifiedPreparation: manifestIdentity(next) };
    await store.save(verified, c.revision);
    signal?.throwIfAborted();
    return verified;
  } finally {
    verifiedSource.destroy();
  }
}
