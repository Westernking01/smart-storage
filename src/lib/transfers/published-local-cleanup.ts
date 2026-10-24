import { type Checkpoint, recovery } from "./checkpoint";
import { canonical } from "./format";
import type { StagingStore } from "./store";

/** Only a durable, verified publication result can admit local payload removal.
 * Keep both checkpoint histories. Never call a cloud operation here. */
export async function cleanupPublishedLocal(
  receipt: Checkpoint,
  target: StagingStore,
  source: StagingStore,
  owner: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const durable = await target.load(receipt.id);
  signal.throwIfAborted();
  if (
    receipt.ownerId !== owner ||
    durable.ownerId !== owner ||
    receipt.phase !== "completed" ||
    durable.phase !== "completed" ||
    recovery(durable).requiresRemoteReconciliation ||
    canonical(durable.manifest) !== canonical(receipt.manifest) ||
    durable.sourceSha256 !== receipt.sourceSha256
  )
    throw Error("LOCAL_DISCARD_UNSAFE");
  if (
    !source.list ||
    !source.releasePublishedPayload ||
    !target.releasePublishedPayload
  )
    throw Error("LOCAL_CLEANUP_PENDING");
  const original = (await source.list()).find((c) => c.id === receipt.id);
  signal.throwIfAborted();
  if (original) await source.releasePublishedPayload(durable);
  signal.throwIfAborted();
  await target.releasePublishedPayload(durable);
  signal.throwIfAborted();
}
