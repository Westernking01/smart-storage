"use client";
import { recovery } from "@/lib/transfers/checkpoint";
import {
  compressionSummary,
  transferError,
  type TransferProgress,
  type ProgressListener,
} from "@/lib/transfers/progress";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useRouter } from "next/navigation";
import {
  cloudRequest,
  uploadPreparedCloud,
  restoreCloud,
} from "@/lib/transfers/cloud-client";
import { Button } from "./ui/button";
import { RestoredFileReady } from "./restored-file-ready";
import { cleanupPublishedLocal } from "@/lib/transfers/published-local-cleanup";
import { PreparedCloudPicker } from "./prepared-cloud-picker";
import { stagePreparedCloud } from "@/lib/transfers/prepared-cloud";
import { ScopedStaging } from "@/lib/transfers/scoped-store";
import {
  uploadPreparedVolume,
  restoreVolume,
  volumeCommand,
  volumeRequest,
} from "@/lib/transfers/volume-client";
import { localDestination } from "@/lib/transfers/sinks";
import { attachmentName } from "@/lib/domain/file-metadata";
import { listenSessionChanges } from "@/lib/backend/session-events";
import type { Checkpoint } from "@/lib/transfers/checkpoint";
const listingSchema = z
  .array(
    z.object({
      id: z.uuid(),
      sessionId: z.uuid(),
      originalName: z.string(),
      originalMime: z.string().nullable(),
      storedBytes: z.string(),
    }),
  )
  .max(50);
type Listing = z.infer<typeof listingSchema>;
function cloudGateReason(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const reasons: Record<string, string> = {
    DEV_CLOUD_DISABLED: "Development cloud transfers are disabled.",
    DEV_CLOUD_CONFIGURATION_INVALID:
      "Development cloud configuration is invalid.",
    CLOUD_PRIVATE_BUCKET_UNVERIFIED:
      "The configured private bucket could not be verified.",
    CLOUD_TRUSTED_RPC_UNAVAILABLE:
      "Restricted publisher authority is unavailable or could not be verified.",
    CLOUD_STORAGE_AUTHORITY_DISABLED:
      "Database allocation has not authorized Storage writes; upload is blocked.",
    CLOUD_COMPRESSED_FILE_REQUIRED:
      "Only previously compressed files can be uploaded. Prepare a compressible file in Compress.",
    CLOUD_PREPARATION_UNVERIFIED:
      "This file has no verified preparation. Prepare it in Compress first.",
    CLOUD_PREPARATION_PROVENANCE_UNAVAILABLE:
      "Cloud upload is blocked because the server cannot yet verify prior local preparation. Your prepared file remains on this device.",
    UNAUTHENTICATED: "Sign in again; this session is not authenticated.",
    CLOUD_PROJECT_ACCOUNT_MISMATCH:
      "The authenticated account does not match this development project.",
  };
  return reasons[code];
}
function prepareInWorker(
  file: File,
  ownerId: string,
  signal: AbortSignal,
  namespace?: string,
  onProgress?: ProgressListener,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../workers/local-transfer.worker.ts", import.meta.url),
    );
    const finish = (error?: Error, id?: string) => {
      worker.onmessage = null;
      worker.onerror = null;
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(id!);
    };
    const abort = () => finish(Error("LOCAL_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(Error("PREPARATION_FAILED"));
    worker.onmessage = ({ data }) => {
      if (signal.aborted) return;
      if (Number.isSafeInteger(data.progress))
        onProgress?.({
          stage: "Compressing",
          bytes: data.progress,
          total: file.size,
        });
      if (typeof data.error === "string") finish(Error(data.error));
      else if (data.result === "prepared") {
        const id = z.uuid().safeParse(data.id);
        if (id.success) finish(undefined, id.data);
        else finish(Error("PREPARATION_FAILED"));
      }
    };
    worker.postMessage({ method: "prepare", file, ownerId, namespace });
  });
}
export function VolumeFiles({
  ownerId,
  cloudScope,
  uploadsOnly = false,
}: {
  ownerId: string;
  cloudScope?: string;
  uploadsOnly?: boolean;
}) {
  const cloud = cloudScope !== undefined;
  const namespace = cloud ? `cloud-${cloudScope}` : undefined;
  const router = useRouter();
  const [files, setFiles] = useState<Listing>([]),
    [prepared, setPrepared] = useState<Checkpoint[]>([]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [session, setSession] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState<string>();
  const [operationGate, setOperationGate] = useState<{
    reason: string;
    uploadOnly: boolean;
  }>();
  const picker = useRef<HTMLInputElement>(null);
  const [preparedPicker, setPreparedPicker] = useState(false);
  const [activity, setActivity] = useState<{
    name: string;
    kind?: "download";
    progress: TransferProgress;
    summary?: string;
  }>();
  const [download, setDownload] = useState<{
    url: string;
    name: string;
    file: File;
    mime: string | null;
  }>();
  const [usage, setUsage] = useState<{
    storedBytes: string;
    reservedBytes: string;
    quotaBytes: string;
  }>();
  const controller = useRef<AbortController | null>(null),
    currentOwner = useRef<string | null>(ownerId);
  const quotaExhausted =
    !!usage &&
    BigInt(usage.storedBytes) + BigInt(usage.reservedBytes) >=
      BigInt(usage.quotaBytes);
  const uploadUnavailable =
    cloud &&
    (loading || !!accessError || !!operationGate || !usage || quotaExhausted);
  const lifecycle = useRef<AbortController | null>(null);
  const output = useRef<{ url: string; remove: () => Promise<void> } | null>(
    null,
  );
  async function refresh(signal: AbortSignal) {
    signal.throwIfAborted();
    const response = cloud
      ? await cloudRequest("", { signal })
      : await volumeRequest("/api/volume-files", { signal });
    const data = z
      .object({
        files: listingSchema,
        account: z.object({
          usage: z.object({
            storedBytes: z.string().regex(/^\d+$/),
            reservedBytes: z.string().regex(/^\d+$/),
            quotaBytes: z.string().regex(/^\d+$/),
          }),
        }),
      })
      .parse(await response.json());
    signal.throwIfAborted();
    if (currentOwner.current !== ownerId)
      throw Error("STAGING_ACCOUNT_CHANGED");
    setLoading(false);
    setAccessError(undefined);
    setFiles(data.files);
    setUsage(data.account.usage);
    const scoped = await ScopedStaging.open(
      { kind: "account", ownerId },
      () => currentOwner.current,
      namespace,
    );
    try {
      const items = await scoped.store.list();
      signal.throwIfAborted();
      signal.throwIfAborted();
      setPrepared(
        items.filter((c) => c.manifest && c.metadata && !c.localPayloadRemoved),
      );
    } finally {
      scoped.close();
    }
  }
  useEffect(() => {
    const mounted = new AbortController();
    lifecycle.current = mounted;
    currentOwner.current = ownerId;
    queueMicrotask(() => {
      void refresh(mounted.signal).catch((error: unknown) => {
        if (mounted.signal.aborted) return;
        setLoading(false);
        setAccessError(
          cloudGateReason(error) ??
            "Development cloud access could not be verified. Check account setup, private bucket and restricted publisher configuration.",
        );
        setMessage(
          cloud
            ? "Development cloud unavailable. Check project, private bucket and backend authority."
            : "Local volume unavailable. Check local database and gateway configuration.",
        );
      });
    });
    const changed = () => {
      if (mounted.signal.aborted) return;
      mounted.abort();
      currentOwner.current = null;
      controller.current?.abort();
      controller.current = null;
      setActivity(undefined);
      setLoading(false);
      setBusy(false);
      setMessage("");
      setFiles([]);
      setPrepared([]);
      setDownload(undefined);
      setPreparedPicker(false);
      setUsage(undefined);
      setAccessError(
        "Session changed. Sign in again before transferring files.",
      );
      setSession(undefined);
      if (output.current) {
        URL.revokeObjectURL(output.current.url);
        void output.current.remove().catch(() => {});
        output.current = null;
      }
    };
    const unsubscribe = listenSessionChanges(changed);
    return () => {
      changed();
      unsubscribe();
    };
    // Owner changes replace the entire account-scoped view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, namespace]);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (
      controller.current ||
      !lifecycle.current ||
      lifecycle.current.signal.aborted
    )
      return;
    const lifetime = lifecycle.current;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lifetime.signal]);
    controller.current = abort;
    setBusy(true);
    setMessage("");
    try {
      await work(signal);
      signal.throwIfAborted();
      if (currentOwner.current === ownerId) await refresh(signal);
    } catch (error) {
      if (
        lifetime.signal.aborted ||
        lifecycle.current !== lifetime ||
        currentOwner.current !== ownerId
      )
        return;
      const gate = cloudGateReason(error);
      if (cloud && gate)
        setOperationGate({
          reason: gate,
          uploadOnly:
            error instanceof Error &&
            [
              "CLOUD_STORAGE_AUTHORITY_DISABLED",
              "CLOUD_PREPARATION_PROVENANCE_UNAVAILABLE",
            ].includes(error.message),
        });
      setActivity(
        (a) =>
          a &&
          (a.progress.stage === "Completed"
            ? a
            : {
                ...a,
                progress: {
                  stage:
                    a.kind === "download" ||
                    a.progress.stage === "Preparing" ||
                    a.progress.stage === "Compressing"
                      ? signal.aborted
                        ? "Cancelled"
                        : "Failed"
                      : "Awaiting reconciliation",
                },
              }),
      );
      void refresh(lifetime.signal).catch(() => {});
      if (signal.aborted) return;
      setMessage(transferError(error));
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        if (!lifecycle.current?.signal.aborted) setBusy(false);
      }
    }
  }
  async function upload(
    signal: AbortSignal,
    checkpoint?: Checkpoint,
    file?: File,
    fromPreparedLibrary = false,
  ) {
    signal.throwIfAborted();
    setActivity({
      name: checkpoint?.metadata?.originalName ?? file?.name ?? "Upload",
      progress: { stage: "Preparing" },
    });
    const report: ProgressListener = (progress) => {
      if (!signal.aborted) setActivity((a) => a && { ...a, progress });
    };
    const scoped = await ScopedStaging.open(
      { kind: "account", ownerId },
      () => currentOwner.current,
      namespace,
    );
    try {
      if (cloud && (!checkpoint || file))
        throw Error("CLOUD_PREPARATION_UNVERIFIED");
      let c =
        checkpoint ??
        (await scoped.store.load(
          await prepareInWorker(file!, ownerId, signal, namespace, report),
        ));
      if (cloud && fromPreparedLibrary) {
        const source = await ScopedStaging.open(
          { kind: "account", ownerId },
          () => currentOwner.current,
        );
        try {
          c = await stagePreparedCloud(
            c.id,
            ownerId,
            source.store,
            scoped.store,
            signal,
          );
        } finally {
          source.close();
        }
      }
      signal.throwIfAborted();
      setActivity(
        (a) =>
          a && {
            ...a,
            summary: compressionSummary(
              c.originalBytes,
              c.blocks.reduce((n, b) => n + b.block.encodedBytes, 0),
            ),
            progress: { stage: "Uploading" },
          },
      );
      setMessage("Uploading prepared blocks…");
      let cleanupPending = false;
      if (cloud) {
        const receipt = await uploadPreparedCloud(
          c,
          scoped.store,
          signal,
          report,
        );
        signal.throwIfAborted();
        try {
          await clearPublished(receipt, scoped.store, signal);
        } catch {
          signal.throwIfAborted();
          cleanupPending = true;
        }
        router.refresh();
      } else {
        await uploadPreparedVolume(
          c,
          scoped.store,
          signal,
          (id) => {
            if (!signal.aborted) setSession(id);
          },
          (n) => {
            if (!signal.aborted) {
              setMessage(`${n} blocks received.`);
              report({ stage: "Uploading", bytes: n, total: c.blocks.length });
            }
          },
        );
      }
      signal.throwIfAborted();
      report({ stage: "Completed" });
      setSession(undefined);
      setMessage(
        cleanupPending
          ? "Upload published. Local cleanup pending; cloud publication will not be repeated."
          : "Upload published. Quota settled from verified encoded bytes and manifest metadata.",
      );
    } finally {
      scoped.close();
    }
  }
  async function clearPublished(
    receipt: Checkpoint,
    target: ScopedStaging,
    signal: AbortSignal,
  ) {
    const source = await ScopedStaging.open(
      { kind: "account", ownerId },
      () => currentOwner.current,
    );
    try {
      await cleanupPublishedLocal(
        receipt,
        target,
        source.store,
        ownerId,
        signal,
      );
      window.dispatchEvent(new Event("smart-storage-local-change"));
    } finally {
      source.close();
    }
  }
  function selectFile(file: File) {
    if (cloud) return;
    if (busy || controller.current || lifecycle.current?.signal.aborted) return;
    if (uploadUnavailable) return;
    if (
      file.size < (cloud ? 1 : 0) ||
      file.size > (cloud ? 6 : 32) * 1024 * 1024
    ) {
      setMessage(
        cloud
          ? "Development cloud files must be from 1 byte to 6 MiB."
          : "Local files must be at most 32 MiB.",
      );
      return;
    }
    void run((signal) => upload(signal, undefined, file));
  }
  return (
    <section
      className="volume-workflow"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (cloud) return;
        const file = e.dataTransfer.files[0];
        if (file) selectFile(file);
      }}
      aria-labelledby={cloud ? "cloud-heading" : "volume-heading"}
    >
      <h2
        id={cloud ? "cloud-heading" : "volume-heading"}
        className="type-section"
      >
        {cloud
          ? uploadsOnly
            ? "Cloud upload"
            : "Development cloud files"
          : "Local gateway files"}
      </h2>
      <p>
        {cloud ? (
          "Private development Storage · files from 1 byte to 6 MiB. Uncertain attempts require reconciliation; never retry an ambiguous transfer."
        ) : (
          <>
            Development volume · 32 MiB maximum original file. Completed blocks
            can continue; interrupted blocks require cleanup. Cloud transfers
            remain disabled.
          </>
        )}
      </p>
      {usage && (
        <p className="numeric">
          {cloud ? "Account usage" : "Local accounting"}: {usage.storedBytes}{" "}
          stored + {usage.reservedBytes} reserved / {usage.quotaBytes} quota
          bytes.
        </p>
      )}
      {cloud && (
        <Button
          disabled={busy || uploadUnavailable}
          onClick={() => setPreparedPicker(true)}
        >
          Upload to Cloud
        </Button>
      )}
      {cloud && preparedPicker && (
        <PreparedCloudPicker
          key={ownerId}
          ownerId={ownerId}
          onClose={() => setPreparedPicker(false)}
          onSelect={(c) => {
            setPreparedPicker(false);
            if (!uploadUnavailable && !busy)
              void run((signal) => upload(signal, c, undefined, true));
          }}
        />
      )}
      {cloud && quotaExhausted && (
        <p role="alert">
          No unreserved account quota is available for a new upload. Existing
          downloads and receipt reconciliation remain separate.
        </p>
      )}
      {cloud && (
        <p>
          Choose a previously prepared, restoration-verified compressed file.
          Uploads are limited to available account quota.
        </p>
      )}
      {!cloud && (
        <label>
          Choose a file to compress and upload{" "}
          <input
            ref={picker}
            type="file"
            disabled={busy || uploadUnavailable}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) selectFile(file);
            }}
          />
        </label>
      )}
      {busy && (
        <Button
          variant="secondary"
          onClick={() => {
            controller.current?.abort();
            setMessage("Transfer stopped. Reserved liability may remain.");
          }}
        >
          Stop current transfer
        </Button>
      )}
      {session && (
        <Button
          disabled={busy}
          variant="danger"
          onClick={() =>
            void run(async () => {
              await volumeCommand({ action: "cancel", id: session });
              setMessage("Cleanup confirmed and reservation released.");
              setSession(undefined);
            })
          }
        >
          Cancel upload and clean up
        </Button>
      )}
      <p role="status">{message}</p>
      {activity && (
        <div className="transfer-activity" aria-label="Current transfer">
          <strong>{activity.name}</strong>
          <p aria-live="polite">{activity.progress.stage}</p>
          {busy && (
            <progress
              aria-label={activity.progress.stage}
              max={activity.progress.total ?? 1}
              value={
                activity.progress.total ? activity.progress.bytes : undefined
              }
            />
          )}
          {activity.progress.total !== undefined && (
            <p className="numeric">
              {activity.progress.bytes ?? 0} / {activity.progress.total}{" "}
              {activity.progress.stage === "Uploading" && !cloud
                ? "blocks received"
                : "acknowledged / processed bytes"}
            </p>
          )}
          {activity.summary && <p className="numeric">{activity.summary}</p>}
        </div>
      )}
      {loading && <p>Loading authorized files…</p>}
      {cloud && (accessError || operationGate) && (
        <p role="alert">
          {operationGate?.reason ?? accessError} No blocked transfer is enabled.
          Uncertain attempts retain their holds.
        </p>
      )}
      {prepared.length > 0 && (
        <details>
          <summary>Prepared uploads on this device</summary>
          <ul>
            {prepared.map((c) => (
              <li key={c.id}>
                <strong>{c.metadata?.originalName}</strong>{" "}
                <span>
                  {recovery(c).completed
                    ? "Published · Local cleanup pending"
                    : recovery(c).requiresRemoteReconciliation
                      ? "Awaiting reconciliation"
                      : "Recoverable interruption"}
                </span>
                <p className="numeric">
                  {compressionSummary(
                    c.originalBytes,
                    c.blocks.reduce((n, b) => n + b.block.encodedBytes, 0),
                  )}
                </p>
                <Button
                  disabled={
                    busy ||
                    (cloud && (loading || !!accessError || !!operationGate))
                  }
                  variant="secondary"
                  onClick={() =>
                    void run(async (signal) => {
                      if (cloud && c.phase === "completed") {
                        const opened = await ScopedStaging.open(
                          { kind: "account", ownerId },
                          () => currentOwner.current,
                          namespace,
                        );
                        try {
                          await clearPublished(c, opened.store, signal);
                          setMessage("Published local payload cleared.");
                        } catch {
                          signal.throwIfAborted();
                          setMessage(
                            "Upload published. Local cleanup pending; cloud publication will not be repeated.",
                          );
                        } finally {
                          opened.close();
                        }
                      } else await upload(signal, c);
                    })
                  }
                >
                  {cloud && c.phase === "completed"
                    ? "Clear published local payload"
                    : "Check or continue upload"}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {uploadsOnly ||
      loading ||
      (cloud && accessError) ? null : files.length === 0 ? (
        <p>
          {cloud
            ? "No ready cloud files."
            : "No ready files on the local volume."}
        </p>
      ) : (
        <ul className="volume-file-list">
          {files.map((f) => (
            <li key={f.id}>
              <span>
                {f.originalName} · {f.storedBytes} accounted bytes
              </span>{" "}
              <Button
                disabled={
                  busy ||
                  (cloud &&
                    (!!accessError ||
                      (!!operationGate && !operationGate.uploadOnly)))
                }
                variant="secondary"
                onClick={() =>
                  void run(async (signal) => {
                    setActivity({
                      name: f.originalName,
                      kind: "download",
                      progress: { stage: "Downloading" },
                    });
                    if (output.current) {
                      URL.revokeObjectURL(output.current.url);
                      await output.current.remove();
                      output.current = null;
                      setDownload(undefined);
                    }
                    const destination = await localDestination(
                      f.id,
                      ownerId,
                      cloud ? 6 * 1024 * 1024 : Infinity,
                    );
                    try {
                      signal.throwIfAborted();
                      await (cloud ? restoreCloud : restoreVolume)(
                        f.sessionId,
                        destination.sink,
                        signal,
                        (progress) => {
                          if (!signal.aborted)
                            setActivity((a) => a && { ...a, progress });
                        },
                      );
                      signal.throwIfAborted();
                      if (currentOwner.current !== ownerId)
                        throw Error("STAGING_ACCOUNT_CHANGED");
                      const restored = await destination.file();
                      signal.throwIfAborted();
                      if (currentOwner.current !== ownerId)
                        throw Error("STAGING_ACCOUNT_CHANGED");
                      const url = URL.createObjectURL(restored);
                      output.current = { url, remove: destination.remove };
                      setActivity({
                        name: f.originalName,
                        progress: { stage: "Completed" },
                      });
                      setDownload({
                        url,
                        file: restored,
                        mime: f.originalMime,
                        name: attachmentName({
                          originalName: f.originalName,
                          originalMime: f.originalMime,
                        }),
                      });
                      setMessage(
                        "Restoration verified. Save the restored file below.",
                      );
                    } catch (error) {
                      await destination.sink.abort(error).catch(() => {});
                      await destination.remove().catch(() => {
                        output.current = {
                          url: "",
                          remove: destination.remove,
                        };
                      });
                      throw error;
                    }
                  })
                }
              >
                Download and restore
              </Button>{" "}
              {!cloud && (
                <Button
                  disabled={busy}
                  variant="danger"
                  onClick={() =>
                    void run(async () => {
                      await volumeCommand({
                        action: "delete",
                        id: f.sessionId,
                      });
                      setMessage("Deletion confirmed. Stored quota released.");
                    })
                  }
                >
                  Delete file
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {download && (
        <RestoredFileReady
          key={download.url}
          {...download}
          valid={() =>
            currentOwner.current === ownerId &&
            !lifecycle.current?.signal.aborted &&
            output.current?.url === download.url
          }
          discard={async () => {
            const current = output.current;
            output.current = null;
            setDownload(undefined);
            if (current) {
              URL.revokeObjectURL(current.url);
              try {
                await current.remove();
                setMessage("Restored copy discarded.");
              } catch {
                output.current = current;
                setMessage("Temporary restore cleanup failed.");
              }
            }
          }}
        />
      )}
    </section>
  );
}
