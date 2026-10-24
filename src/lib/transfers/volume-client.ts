import type { ProgressListener } from "./progress";
import { z } from "zod";
import { notifySessionChange } from "../backend/session-events";
import { parseManifest } from "./format";
import type { Checkpoint } from "./checkpoint";
import type { StagingStore } from "./store";
import { restore, type RestoreSink } from "./restore";
export async function volumeRequest(path: string, init?: RequestInit) {
  init?.signal?.throwIfAborted();
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) notifySessionChange();
  if (init?.signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    init.signal.throwIfAborted();
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw Error(
      typeof error?.error?.code === "string"
        ? error.error.code
        : "TRANSFER_FAILED",
    );
  }
  return response;
}
const progress = z.object({
  id: z.uuid(),
  state: z.string(),
  fileId: z.uuid(),
  objects: z
    .array(
      z.object({
        index: z.number().int(),
        state: z.enum(["pending", "writing", "complete", "removed"]),
      }),
    )
    .min(1)
    .max(128),
});
export async function volumeCommand(value: unknown, signal?: AbortSignal) {
  return (
    await volumeRequest("/api/volume-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
      signal,
    })
  ).json();
}
/** Block-boundary continuation only: durable complete blocks are skipped.
 * Never resend an ambiguous/writing block or claim partial-byte resumability. */
export async function uploadPreparedVolume(
  checkpoint: Checkpoint,
  store: StagingStore,
  signal: AbortSignal,
  onSession: (id: string) => void,
  onProgress?: (blocks: number) => void,
) {
  signal.throwIfAborted();
  checkpoint = await store.load(checkpoint.id);
  signal.throwIfAborted();
  if (!checkpoint.manifest || !checkpoint.metadata)
    throw Error("PREPARATION_REQUIRED");
  const manifest = parseManifest(checkpoint.manifest);
  const status = progress.parse(
    await volumeCommand(
      {
        action: "begin",
        key: checkpoint.id,
        metadata: checkpoint.metadata,
        manifest,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  onSession(status.id);
  if (status.state === "completed")
    return { fileId: status.fileId, state: "completed" };
  if (status.state !== "uploading") throw Error("SESSION_BLOCKED");
  if (status.objects.some((o) => o.state === "writing"))
    throw Error("ATTEMPT_AMBIGUOUS");
  for (const b of manifest.blocks) {
    signal.throwIfAborted();
    const object = status.objects.find((o) => o.index === b.index);
    if (object?.state === "complete") {
      onProgress?.(b.index + 1);
      continue;
    }
    if (object?.state !== "pending") throw Error("SESSION_BLOCKED");
    const blob = await store.block(checkpoint.id, b.index);
    if (blob.size !== b.encodedBytes) throw Error("STAGED_INTEGRITY");
    await volumeRequest(`/api/volume-files/${status.id}/blocks/${b.index}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
      signal,
    });
    signal.throwIfAborted();
    onProgress?.(b.index + 1);
  }
  signal.throwIfAborted();
  return volumeCommand({ action: "publish", id: status.id }, signal);
}
export async function restoreVolume(
  sessionId: string,
  sink: RestoreSink,
  signal: AbortSignal,
  onProgress?: ProgressListener,
) {
  z.uuid().parse(sessionId);
  const response = await volumeRequest(
    `/api/volume-files?id=${sessionId}&ready=true`,
    { signal },
  );
  const status = z
    .object({ manifest: z.unknown() })
    .parse(await response.json());
  return restore(
    status.manifest,
    {
      async open(block, signal) {
        const response = await volumeRequest(
          `/api/volume-files/${sessionId}/blocks/${block.index}`,
          { signal },
        );
        if (!response.body) throw Error("DOWNLOAD_FAILED");
        return { index: block.index, stream: response.body };
      },
    },
    sink,
    signal,
    undefined,
    onProgress,
  );
}
