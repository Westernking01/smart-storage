"use client";
import { useEffect, useRef, useState } from "react";
import { restoreCloud } from "@/lib/transfers/cloud-client";
import { localDestination } from "@/lib/transfers/sinks";
import { listenSessionChanges } from "@/lib/backend/session-events";
import { attachmentName } from "@/lib/domain/file-metadata";
import { type TransferProgress } from "@/lib/transfers/progress";
import { RestoredFileReady } from "./restored-file-ready";
import { Button } from "./ui/button";

type RestoreFile = {
  id: string;
  name: string;
  originalName: string;
  originalMime: string | null;
};
export function useCloudRestoration(ownerId: string) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TransferProgress>();
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{
    file: File;
    name: string;
    mime: string | null;
    url: string;
  }>();
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const output = useRef<{ url: string; remove: () => Promise<void> } | null>(
    null,
  );
  const panel = useRef<HTMLElement | null>(null);
  async function discard() {
    const old = output.current;
    setResult(undefined);
    if (old) {
      URL.revokeObjectURL(old.url);
      await old.remove();
      if (output.current === old) output.current = null;
    }
  }
  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    const dispose = () => {
      active.abort();
      operation.current?.abort();
      const old = output.current;
      output.current = null;
      if (old) {
        URL.revokeObjectURL(old.url);
        void old.remove().catch(() => {});
      }
    };
    const changed = () => {
      dispose();
      setResult(undefined);
      setBusy(false);
      setProgress(undefined);
      setMessage("Session changed. Restored copy is unavailable.");
    };
    const stop = listenSessionChanges(changed);
    return () => {
      dispose();
      stop();
    };
  }, [ownerId]);
  async function start(file: RestoreFile) {
    const active = lifetime.current;
    if (!active || active.signal.aborted || operation.current) return;
    const abort = new AbortController();
    operation.current = abort;
    const signal = AbortSignal.any([active.signal, abort.signal]);
    setBusy(true);
    setMessage("");
    setProgress({ stage: "Downloading" });
    let destination: Awaited<ReturnType<typeof localDestination>> | undefined;
    try {
      await discard();
      signal.throwIfAborted();
      destination = await localDestination(file.id, ownerId, 6 * 1024 * 1024);
      signal.throwIfAborted();
      await restoreCloud(file.id, destination.sink, signal, (value) => {
        if (!signal.aborted) setProgress(value);
      });
      signal.throwIfAborted();
      const restored = await destination.file();
      signal.throwIfAborted();
      if (lifetime.current !== active) throw Error("STAGING_ACCOUNT_CHANGED");
      const name = attachmentName({
        originalName: file.originalName,
        originalMime: file.originalMime,
      });
      const url = URL.createObjectURL(restored);
      output.current = { url, remove: destination.remove };
      setResult({
        file: restored,
        url,
        mime: file.originalMime,
        name,
      });
      setProgress({ stage: "Completed" });
      setMessage("Restoration verified.");
      requestAnimationFrame(() => {
        if (!signal.aborted) {
          panel.current?.scrollIntoView({ block: "nearest" });
          panel.current?.focus();
        }
      });
    } catch {
      if (destination) {
        await destination.sink.abort("RESTORE_STOPPED").catch(() => {});
        await destination.remove().catch(() => {
          output.current = { url: "", remove: destination!.remove };
        });
      }
      if (!active.signal.aborted && lifetime.current === active) {
        setProgress({ stage: signal.aborted ? "Cancelled" : "Failed" });
        setMessage(
          signal.aborted
            ? "Restoration cancelled."
            : "Cloud restoration failed. No verified copy is ready to save.",
        );
      }
    } finally {
      if (operation.current === abort) operation.current = null;
      if (!active.signal.aborted && lifetime.current === active) setBusy(false);
    }
  }
  return {
    start,
    busy,
    panel: (
      <section
        className="explorer-restoration"
        ref={panel}
        tabIndex={-1}
        aria-label="Cloud restoration"
      >
        {progress && (
          <p>
            {progress.stage === "Saving"
              ? "Preparing restored copy"
              : progress.stage}
            {progress.total !== undefined
              ? ` · ${progress.bytes ?? 0} / ${progress.total} bytes`
              : ""}
          </p>
        )}
        <p role="status">{message}</p>
        {busy && (
          <Button
            variant="secondary"
            onClick={() => operation.current?.abort()}
          >
            Cancel restoration
          </Button>
        )}
        {result && (
          <RestoredFileReady
            key={result.url}
            {...result}
            valid={() =>
              !!lifetime.current &&
              !lifetime.current.signal.aborted &&
              output.current?.url === result.url
            }
            discard={async () => {
              try {
                await discard();
                setMessage("Restored copy discarded.");
              } catch {
                setMessage("Temporary restore cleanup pending.");
              }
            }}
          />
        )}
      </section>
    ),
  };
}
