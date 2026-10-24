import { ScopedStaging } from "../lib/transfers/scoped-store";
import { prepare } from "../lib/transfers/prepare";
import { restore } from "../lib/transfers/restore";
import { localDestination } from "../lib/transfers/sinks";
import { recovery, totals } from "../lib/transfers/checkpoint";
import { stopLocal } from "../lib/transfers/upload";
import { attachmentName } from "../lib/domain/file-metadata";
const scope = globalThis as unknown as {
  onmessage: (
    e: MessageEvent<{
      method: string;
      id?: string;
      file?: File;
      ownerId?: string;
      namespace?: string;
      displayName?: string;
      announceRecovery?: boolean;
    }>,
  ) => void;
  postMessage: (value: unknown) => void;
};
let active: AbortController | undefined;
let removeOutput: (() => Promise<void>) | undefined;
let boundOwner: string | null | undefined;
scope.onmessage = (e) => {
  if (e.data.method === "cancel") {
    active?.abort(new DOMException("Cancelled", "AbortError"));
    return;
  }
  if (active) {
    scope.postMessage({ error: "LOCAL_OPERATION_BUSY" });
    return;
  }
  const controller = new AbortController();
  active = controller;
  void (async () => {
    const owner = e.data.ownerId ?? null;
    if (boundOwner !== undefined && boundOwner !== owner)
      throw Error("STAGING_ACCOUNT_CHANGED");
    boundOwner = owner;
    const opened = await ScopedStaging.open(
      owner ? { kind: "account", ownerId: owner } : { kind: "anonymous" },
      () => boundOwner ?? null,
      e.data.namespace,
    );
    const store = opened.store;
    try {
      const { method, id, file } = e.data;
      if (method === "ready") {
        scope.postMessage({ result: "ready" });
      } else if (method === "list") {
        const checkpoints = await store.list();
        scope.postMessage({
          result: "listed",
          announceRecovery: e.data.announceRecovery === true,
          files: checkpoints
            .filter((c) => !c.localPayloadRemoved)
            .map((c) => ({
              id: c.id,
              name: c.displayName ?? attachmentName(c.metadata),
              originalName: attachmentName(c.metadata),
              mime: c.metadata?.originalMime ?? null,
              phase: c.phase,
              verified: !!c.verifiedPreparation,
              codecs: [...new Set(c.blocks.map((p) => p.block.codec))],
              cloudPrepared:
                c.phase === "prepared" &&
                !recovery(c).requiresRemoteReconciliation &&
                c.blocks.every((p) => p.attemptedBytes === 0) &&
                !!c.verifiedPreparation &&
                !!c.ownerId &&
                c.originalBytes > 0 &&
                c.originalBytes <= 6 * 1024 * 1024 &&
                c.blocks.length > 0 &&
                c.blocks.every((p) => p.block.codec === "gzip"),
              createdAt: c.createdAt ?? null,
              ...totals(c),
            })),
        });
      } else if (method === "prepare" || method === "resume") {
        if (!file) throw Error("SOURCE_REQUIRED");
        const c = await prepare(
          file,
          store,
          controller.signal,
          method === "resume" ? id : undefined,
          (next) =>
            scope.postMessage({
              progress: next.blocks.reduce(
                (n, p) => n + p.block.originalBytes,
                0,
              ),
              id: next.id,
              phase:
                next.blocks.length > 0 &&
                next.blocks.reduce((n, p) => n + p.block.originalBytes, 0) ===
                  next.originalBytes
                  ? "verifying"
                  : "preparing",
            }),
          { originalName: file.name, originalMime: file.type || null },
        );
        scope.postMessage({ result: "prepared", id: c.id, totals: totals(c) });
      } else if (method === "rename") {
        const c = await store.rename(id!, e.data.displayName!);
        scope.postMessage({ result: "renamed", id: c.id });
      } else if (method === "delete") {
        await store.delete(id!);
        scope.postMessage({ result: "deleted", id });
      } else if (method === "inspect") {
        const c = await store.load(id!);
        scope.postMessage({
          result: "recovered",
          id: c.id,
          phase: c.phase,
          missingSource: recovery(c).missingSource,
          totals: totals(c),
        });
      } else if (method === "restore") {
        const c = await store.load(id!);
        if (c.localPayloadRemoved) throw Error("LOCAL_PAYLOAD_REMOVED");
        if (!c.manifest) throw Error("PREPARATION_INCOMPLETE_RESELECT_SOURCE");
        const destination = await localDestination(c.id, c.ownerId);
        const result = await restore(
          c.manifest,
          {
            open: async (block) => {
              const blob = await store.block(c.id, block.index);
              return { index: block.index, stream: blob.stream() };
            },
          },
          destination.sink,
          controller.signal,
          (progress) => scope.postMessage({ restoreProgress: progress, id }),
        );
        const output = await destination.file();
        removeOutput = destination.remove; // Keep the disk-backed File valid until explicit local discard.
        scope.postMessage({
          result: "verified",
          ...result,
          file: output,
          downloadName: attachmentName(c.metadata),
        });
      } else if (method === "discard") {
        await stopLocal(id!, store);
        await store.discardLocalBlocks(id!);
        await removeOutput?.();
        removeOutput = undefined;
        scope.postMessage({ result: "discarded" });
      } else throw Error("LOCAL_METHOD_INVALID");
    } finally {
      opened.close();
    }
  })()
    .catch((error) =>
      scope.postMessage({
        error:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : error?.name === "AbortError"
              ? "LOCAL_CANCELLED"
              : "LOCAL_OPERATION_FAILED",
      }),
    )
    .finally(() => {
      active = undefined;
    });
};
