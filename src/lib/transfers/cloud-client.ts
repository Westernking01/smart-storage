import type { ProgressListener } from "./progress";
import { z } from "zod";
import { notifySessionChange } from "../backend/session-events";
import { upload } from "./upload";
import { restore, type RestoreSink } from "./restore";
import { canonical, parseManifest } from "./format";
import { digest } from "./codec";
import type { Checkpoint } from "./checkpoint";
import { recovery } from "./checkpoint";
import type { StagingStore } from "./store";
import { loadPreparedCloud } from "./prepared-cloud";

export async function cloudRequest(path = "", init?: RequestInit) {
  init?.signal?.throwIfAborted();
  const response = await fetch(`/api/development-cloud${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (response.status === 401) notifySessionChange();
  if (init?.signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    init.signal.throwIfAborted();
  }
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw Error(
      typeof value?.error?.code === "string" &&
        /^[A-Z_]+$/.test(value.error.code)
        ? value.error.code
        : "CLOUD_REQUEST_FAILED",
    );
  }
  return response;
}
async function command(value: unknown, signal?: AbortSignal) {
  return (
    await cloudRequest("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
      signal,
    })
  ).json();
}
export async function uploadPreparedCloud(
  checkpoint: Checkpoint,
  store: StagingStore,
  signal: AbortSignal,
  onProgress?: ProgressListener,
) {
  signal.throwIfAborted();
  // Reload through the account-scoped store before any request, including receipt recovery.
  checkpoint = await store.load(checkpoint.id);
  signal.throwIfAborted();
  if (
    !checkpoint.manifest ||
    !checkpoint.ownerId ||
    checkpoint.originalBytes < 1 ||
    checkpoint.originalBytes > 6 * 1024 * 1024
  )
    throw Error("DEV_CLOUD_FILE_LIMIT");
  const manifest = checkpoint.manifest;
  let acknowledged = checkpoint.blocks.reduce(
    (n, b) => n + b.acknowledgedBytes,
    0,
  );
  const total = manifest.blocks.reduce((n, b) => n + b.encodedBytes, 0);
  if (
    checkpoint.phase === "completed" ||
    recovery(checkpoint).requiresRemoteReconciliation
  ) {
    onProgress?.({ stage: "Awaiting reconciliation" });
    const receipt = z
      .object({
        published: z.literal(true),
        manifestSha256: z.string(),
        originalSha256: z.string(),
      })
      .parse(
        await (
          await cloudRequest(
            `?key=${checkpoint.id}&owner=${checkpoint.ownerId}`,
            { signal },
          )
        ).json(),
      );
    signal.throwIfAborted();
    if (
      receipt.manifestSha256 !==
        digest(new TextEncoder().encode(canonical(manifest))) ||
      receipt.originalSha256 !== checkpoint.sourceSha256
    )
      throw Error("PUBLICATION_NOT_VERIFIED");
    if (checkpoint.phase === "completed") return checkpoint;
    const next = structuredClone(checkpoint);
    next.revision++;
    next.phase = "completed";
    for (const progress of next.blocks) {
      if (progress.attemptedBytes < progress.block.encodedBytes)
        throw Error("PUBLICATION_NOT_VERIFIED");
      progress.phase = "completed";
      progress.acknowledgedBytes = progress.block.encodedBytes;
    }
    await store.save(next, checkpoint.revision);
    signal.throwIfAborted();
    return next;
  }
  checkpoint = await loadPreparedCloud(
    checkpoint.id,
    checkpoint.ownerId,
    store,
    signal,
  );
  const session = z
    .object({ fileId: z.uuid(), permits: z.record(z.string(), z.string()) })
    .parse(await command({ action: "begin", checkpoint }, signal));
  return upload(
    checkpoint.id,
    store,
    {
      async write(request) {
        onProgress?.({ stage: "Uploading", bytes: acknowledged, total });
        if (request.offset !== 0) throw Error("UPLOAD_RECOVERY_REQUIRED");
        return z.object({ offset: z.number().int().nonnegative() }).parse(
          await (
            await cloudRequest(
              `?id=${request.id}&index=${request.block}&request=${request.attemptId}`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "x-cloud-permit": session.permits[request.block] ?? "",
                },
                body: request.body,
                signal: request.signal,
              },
            )
          ).json(),
        );
      },
      async verify(id, index, signal) {
        acknowledged +=
          manifest.blocks[index].encodedBytes -
          checkpoint.blocks[index].acknowledgedBytes;
        onProgress?.({ stage: "Verifying" });
        return z
          .object({
            encodedBytes: z.number().int().nonnegative(),
            encodedSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(await command({ action: "verify", id, index }, signal));
      },
      async publish(id, expected, signal) {
        onProgress?.({ stage: "Publishing" });
        if (digest(new TextEncoder().encode(canonical(manifest))) !== expected)
          throw Error("MANIFEST_INTEGRITY");
        return z
          .object({
            published: z.literal(true),
            manifestSha256: z.string(),
            originalSha256: z.string(),
          })
          .parse(await command({ action: "publish", id, manifest }, signal));
      },
    },
    signal,
  );
}
export async function restoreCloud(
  fileId: string,
  sink: RestoreSink,
  signal: AbortSignal,
  onProgress?: ProgressListener,
) {
  let manifest: unknown;
  try {
    z.uuid().parse(fileId);
    ({ manifest } = z
      .object({ manifest: z.unknown() })
      .parse(await (await cloudRequest(`?id=${fileId}`, { signal })).json()));
    if (parseManifest(manifest).originalBytes > 6 * 1024 * 1024)
      throw Error("DEV_CLOUD_FILE_LIMIT");
  } catch (error) {
    await sink.abort(error).catch(() => {});
    throw error;
  }
  return restore(
    manifest,
    {
      async open(block, signal) {
        const response = await cloudRequest(
          `/${fileId}/blocks/${block.index}`,
          { signal },
        );
        if (!response.body) throw Error("CLOUD_DOWNLOAD_FAILED");
        // Network chunk sizes are not a format contract. Rechunk before bounded restore.
        const reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
          async pull(controller) {
            try {
              signal?.throwIfAborted();
              const { value, done } = await reader.read();
              if (done) {
                reader.releaseLock();
                controller.close();
                return;
              }
              for (let offset = 0; offset < value.length; offset += 65536)
                controller.enqueue(value.slice(offset, offset + 65536));
            } catch (error) {
              await reader.cancel().catch(() => {});
              controller.error(error);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            reader.releaseLock();
          },
        });
        return { index: block.index, stream };
      },
    },
    sink,
    signal,
    undefined,
    onProgress,
  );
}
