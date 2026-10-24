"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "./ui/button";
import { ScopedStaging } from "@/lib/transfers/scoped-store";
import { loadPreparedCloud } from "@/lib/transfers/prepared-cloud";
import { compressionSummary } from "@/lib/transfers/progress";
import type { Checkpoint } from "@/lib/transfers/checkpoint";

export function PreparedCloudPicker({
  ownerId,
  onClose,
  onSelect,
}: {
  ownerId: string;
  onClose: () => void;
  onSelect: (c: Checkpoint) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<Checkpoint[]>([]);
  const [status, setStatus] = useState(
    "Checking prepared files and restoration integrity…",
  );
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  useEffect(() => {
    const abort = new AbortController();
    dialog.current?.showModal();
    void (async () => {
      const opened = await ScopedStaging.open(
        { kind: "account", ownerId },
        () => (abort.signal.aborted ? null : ownerId),
      );
      try {
        const eligible: Checkpoint[] = [];
        const requested = new URLSearchParams(window.location.search).get(
          "prepared",
        );
        for (const c of await opened.store.list()) {
          if (requested && c.id !== requested) continue;
          abort.signal.throwIfAborted();
          // Picker offers only unused preparation. Transfer recovery stays in
          // the existing checkpoint UI, preserving publication uncertainty.
          if (
            c.phase !== "prepared" ||
            c.blocks.some((p) => p.attemptedBytes > 0)
          )
            continue;
          try {
            eligible.push(
              await loadPreparedCloud(
                c.id,
                ownerId,
                opened.store,
                abort.signal,
              ),
            );
          } catch {
            abort.signal.throwIfAborted();
          }
        }
        abort.signal.throwIfAborted();
        setEntries(eligible);
        setStatus(
          eligible.length
            ? "Choose a verified compressed file."
            : "No eligible prepared compressed files. Prepare a compressible file of 1 byte to 6 MiB on Overview while signed in to this account. Unverified, raw, missing and damaged entries are excluded.",
        );
      } finally {
        opened.close();
      }
    })().catch(() => {
      if (!abort.signal.aborted)
        setStatus(
          "Local prepared files could not be verified. No upload was started.",
        );
    });
    return () => {
      abort.abort();
    };
  }, [ownerId]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="prepared-picker-heading"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={onClose}
    >
      <h2 id="prepared-picker-heading" className="type-section">
        Prepared compressed files
      </h2>
      <p role="status">{status}</p>
      <ul className="volume-file-list">
        {entries.map((c) => (
          <li key={c.id}>
            <strong>{c.metadata!.originalName}</strong>
            <p className="numeric">
              Original: {c.originalBytes} bytes · Compressed:{" "}
              {c.blocks.reduce((n, p) => n + p.block.encodedBytes, 0)} bytes
            </p>
            <p>
              {compressionSummary(
                c.originalBytes,
                c.blocks.reduce((n, p) => n + p.block.encodedBytes, 0),
              )}
            </p>
            <Button onClick={() => onSelect(c)}>
              Upload {c.metadata!.originalName}
            </Button>
          </li>
        ))}
      </ul>
      <Link href="/" prefetch={false}>
        Prepare a file on Overview
      </Link>{" "}
      <Button variant="secondary" onClick={close}>
        Cancel
      </Button>
    </dialog>
  );
}
