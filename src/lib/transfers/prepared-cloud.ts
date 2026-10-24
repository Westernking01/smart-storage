import { validateCheckpoint, recovery, type Checkpoint } from "./checkpoint";
import { canonical } from "./format";
import { digest } from "./codec";
import { restore } from "./restore";
import type { StagingStore } from "./store";

export const manifestIdentity = (c: Checkpoint) =>
  digest(new TextEncoder().encode(canonical(c.manifest)));

/** Local evidence only. This is not a server-issued preparation attestation. */
export function preparedCloudMetadata(value: unknown, ownerId: string) {
  const c = validateCheckpoint(value);
  if (c.localPayloadRemoved) throw Error("LOCAL_PAYLOAD_REMOVED");
  if (c.ownerId !== ownerId) throw Error("STAGING_OWNER_MISMATCH");
  if (
    !c.manifest ||
    !c.metadata ||
    c.originalBytes < 1 ||
    c.originalBytes > 6 * 1024 * 1024 ||
    !["prepared", "acknowledged", "completed"].includes(c.phase) ||
    recovery(c).requiresRemoteReconciliation
  )
    throw Error("CLOUD_CHECKPOINT_BLOCKED");
  if (!c.blocks.length || c.blocks.some((p) => p.block.codec !== "gzip"))
    throw Error("CLOUD_COMPRESSED_FILE_REQUIRED");
  if (c.verifiedPreparation !== manifestIdentity(c))
    throw Error("CLOUD_PREPARATION_UNVERIFIED");
  return c;
}

/** Reuse the bounded restoration verifier without retaining a second original. */
export async function verifyStagedPreparation(
  c: Checkpoint,
  store: StagingStore,
  signal?: AbortSignal,
) {
  if (!c.manifest) throw Error("CLOUD_PREPARATION_UNVERIFIED");
  await restore(
    c.manifest,
    {
      open: async (block) => {
        const blob = await store.block(c.id, block.index);
        signal?.throwIfAborted();
        let offset = 0;
        return {
          index: block.index,
          stream: new ReadableStream<Uint8Array<ArrayBuffer>>({
            async pull(controller) {
              signal?.throwIfAborted();
              if (offset === blob.size) {
                controller.close();
                return;
              }
              const bytes = new Uint8Array(
                await blob.slice(offset, offset + 65536).arrayBuffer(),
              );
              signal?.throwIfAborted();
              offset += bytes.length;
              controller.enqueue(bytes);
            },
          }),
        };
      },
    },
    { write: async () => {}, commit: async () => {}, abort: async () => {} },
    signal,
  );
  signal?.throwIfAborted();
}

export async function loadPreparedCloud(
  id: string,
  ownerId: string,
  store: StagingStore,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const c = preparedCloudMetadata(await store.load(id), ownerId);
  await verifyStagedPreparation(c, store, signal);
  // Fence account changes and local revision races across verification.
  const latest = await store.load(id);
  signal?.throwIfAborted();
  if (
    latest.revision !== c.revision ||
    manifestIdentity(latest) !== manifestIdentity(c)
  )
    throw Error("CHECKPOINT_CONFLICT");
  return c;
}

/** Copy verified encoded blocks into the existing project/bucket namespace.
 * Never recompress, reset transfer progress or replace an ambiguous checkpoint.
 */
export async function stagePreparedCloud(
  id: string,
  ownerId: string,
  source: StagingStore,
  target: StagingStore,
  signal: AbortSignal,
) {
  const c = await loadPreparedCloud(id, ownerId, source, signal);
  if (!target.list) throw Error("STAGING_LIST_UNSUPPORTED");
  let saved = (await target.list()).find((item) => item.id === id);
  signal.throwIfAborted();
  if (saved) {
    if (
      saved.ownerId !== ownerId ||
      manifestIdentity(saved) !== manifestIdentity(c) ||
      canonical(saved.metadata) !== canonical(c.metadata)
    )
      throw Error("CHECKPOINT_CONFLICT");
    if (
      saved.phase !== "prepared" ||
      saved.blocks.some((p) => p.attemptedBytes > 0)
    )
      return saved;
  }
  for (const p of c.blocks) {
    const blob = await source.block(id, p.block.index);
    signal.throwIfAborted();
    const next = { ...(saved ?? c), revision: saved ? saved.revision + 1 : 0 };
    await target.save(next, saved ? saved.revision : null, {
      index: p.block.index,
      blob,
    });
    saved = next;
  }
  return loadPreparedCloud(id, ownerId, target, signal);
}
