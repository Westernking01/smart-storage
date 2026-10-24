import { canonical, fail } from "./format";
import { digest, sourceHash } from "./codec";
import { recovery, type Checkpoint } from "./checkpoint";
import type { StagingStore } from "./store";
export const TRANSPORT_CHUNK = 6 * 1024 * 1024;
export interface UploadTransport {
  write(request: {
    id: string;
    block: number;
    offset: number;
    attemptId: string;
    body: Uint8Array<ArrayBuffer>;
    signal?: AbortSignal;
  }): Promise<{ offset: number }>;
  verify(
    id: string,
    block: number,
    signal?: AbortSignal,
  ): Promise<{ encodedBytes: number; encodedSha256: string }>;
  publish(
    id: string,
    manifestSha256: string,
    signal?: AbortSignal,
  ): Promise<{
    published: true;
    manifestSha256: string;
    originalSha256: string;
  }>;
}
async function persist(
  store: StagingStore,
  c: Checkpoint,
  change: (next: Checkpoint) => void,
) {
  const next = structuredClone(c);
  change(next);
  next.revision++;
  await store.save(next, c.revision);
  return next;
}
export async function upload(
  id: string,
  store: StagingStore,
  transport: UploadTransport,
  signal?: AbortSignal,
) {
  let c = await store.load(id);
  if (
    !c.manifest ||
    recovery(c).requiresRemoteReconciliation ||
    !["prepared", "acknowledged"].includes(c.phase)
  )
    fail("UPLOAD_RECOVERY_REQUIRED");
  for (let index = 0; index < c.blocks.length; index++) {
    if (c.blocks[index].phase === "completed") continue;
    signal?.throwIfAborted();
    const staged = await store.block(id, index),
      descriptor = c.blocks[index].block;
    if (
      staged.size !== descriptor.encodedBytes ||
      (await sourceHash(staged, signal)) !== descriptor.encodedSha256
    )
      fail("STAGED_INTEGRITY");
    // Zero-byte objects need explicit provider verification, not a fabricated PATCH.
    while (c.blocks[index].acknowledgedBytes < staged.size) {
      signal?.throwIfAborted();
      const offset = c.blocks[index].acknowledgedBytes;
      const body = new Uint8Array(
        await staged.slice(offset, offset + TRANSPORT_CHUNK).arrayBuffer(),
      );
      signal?.throwIfAborted();
      const attemptId = crypto.randomUUID();
      c = await persist(store, c, (next) => {
        next.phase = "uploading";
        const p = next.blocks[index];
        p.phase = "uploading";
        p.attemptId = attemptId;
        p.attemptedBytes += body.length;
      });
      try {
        signal?.throwIfAborted();
        const result = await transport.write({
          id,
          block: index,
          offset,
          attemptId,
          body,
          signal,
        });
        if (result.offset !== offset + body.length)
          fail("UPLOAD_OFFSET_MISMATCH");
        signal?.throwIfAborted();
        c = await persist(store, c, (next) => {
          const p = next.blocks[index];
          p.acknowledgedBytes = result.offset;
          p.phase = result.offset === staged.size ? "acknowledged" : "prepared";
          next.phase = "prepared";
        });
      } catch (e) {
        // Reload before append: an uncertain local commit is not repaired here.
        const durable = await store.load(id);
        if (durable.blocks[index].phase === "uploading")
          await persist(store, durable, (next) => {
            next.phase = "ambiguous";
            next.blocks[index].phase = "ambiguous";
          });
        throw e;
      }
    }
    signal?.throwIfAborted();
    const proof = await transport.verify(id, index, signal);
    signal?.throwIfAborted();
    if (
      proof.encodedBytes !== descriptor.encodedBytes ||
      proof.encodedSha256 !== descriptor.encodedSha256
    ) {
      await persist(store, c, (next) => {
        next.phase = "failed";
        next.blocks[index].phase = "failed";
      });
      fail("REMOTE_BLOCK_INTEGRITY");
    }
    c = await persist(store, c, (next) => {
      next.blocks[index].phase = "completed";
      next.phase = "prepared";
    });
  }
  c = await persist(store, c, (next) => {
    next.phase = "acknowledged";
  });
  signal?.throwIfAborted();
  const manifestSha256 = digest(
    new TextEncoder().encode(canonical(c.manifest)),
  );
  c = await persist(store, c, (next) => {
    next.phase = "uploading";
    next.publication = "intent";
  });
  try {
    signal?.throwIfAborted();
    c = await persist(store, c, (next) => {
      next.publication = "dispatched";
    });
    signal?.throwIfAborted();
    const proof = await transport.publish(id, manifestSha256, signal);
    signal?.throwIfAborted();
    if (
      proof.published !== true ||
      proof.manifestSha256 !== manifestSha256 ||
      proof.originalSha256 !== c.sourceSha256
    )
      fail("PUBLICATION_NOT_VERIFIED");
  } catch (e) {
    const durable = await store.load(id);
    if (durable.phase === "uploading")
      await persist(store, durable, (next) => {
        if (durable.publication === "intent" && signal?.aborted) {
          next.phase = "acknowledged";
          next.publication = "cancelled-before-dispatch";
        } else next.phase = "ambiguous";
      });
    throw e;
  }
  return persist(store, c, (next) => {
    next.phase = "completed";
  });
}
// Explicitly supplied read-only evidence only. An offset is not content integrity.
export async function reconcileOffset(
  id: string,
  index: number,
  offset: number,
  store: StagingStore,
) {
  const c = await store.load(id),
    p = c.blocks[index];
  if (
    c.publication !== undefined ||
    !p ||
    !["ambiguous", "uploading"].includes(p.phase) ||
    !Number.isSafeInteger(offset) ||
    offset < p.acknowledgedBytes ||
    offset > p.block.encodedBytes ||
    offset > p.attemptedBytes
  )
    fail("RECONCILIATION_INVALID");
  return persist(store, c, (next) => {
    const b = next.blocks[index];
    b.acknowledgedBytes = offset;
    b.phase = offset === b.block.encodedBytes ? "acknowledged" : "prepared";
    next.phase = "prepared";
  });
}
export async function stopLocal(
  id: string,
  store: StagingStore,
  abandon = false,
) {
  const c = await store.load(id);
  if (
    c.phase === "completed" ||
    c.phase === "uploading" ||
    recovery(c).requiresRemoteReconciliation ||
    (!abandon && c.blocks.some((p) => p.attemptedBytes > 0))
  )
    fail("CANCELLATION_REQUIRES_RECONCILIATION");
  return persist(store, c, (next) => {
    next.phase = abandon ? "abandoned" : "cancelled";
  });
}
