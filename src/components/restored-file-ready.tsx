"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { writableSink } from "@/lib/transfers/sinks";
import Shield from "@boxicons/react/Shield";
import ArchiveArrowDown from "@boxicons/react/ArchiveArrowDown";

export function RestoredFileReady({
  file,
  name,
  mime,
  url,
  valid,
  discard,
}: {
  file: File;
  name: string;
  mime: string | null;
  url: string;
  valid: () => boolean;
  discard: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  async function save() {
    if (!valid() || saving) return;
    setSaving(true);
    let sink: ReturnType<typeof writableSink> | undefined;
    try {
      const picker = (
        window as Window & {
          showSaveFilePicker?: (options: {
            suggestedName: string;
          }) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker;
      if (picker) {
        const handle = await picker.call(window, { suggestedName: name });
        if (!valid()) throw Error();
        sink = writableSink(await handle.createWritable());
        const reader = file.stream().getReader();
        try {
          for (;;) {
            if (!valid()) throw Error();
            const { value, done } = await reader.read();
            if (!valid()) throw Error();
            if (done) break;
            await sink.write(value);
          }
          if (!valid()) throw Error();
          await sink.commit();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (valid()) setStatus("Saved to device.");
      } else {
        if (!valid()) throw Error();
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        setStatus("Save handed to browser.");
      }
    } catch {
      await sink?.abort("SAVE_CANCELLED").catch(() => {});
      if (valid())
        setStatus(
          "Save cancelled or unavailable. Verified copy remains ready.",
        );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section aria-label="Restored File Ready">
      <div className="restored-result-heading">
        <Shield width={25} height={25} aria-hidden="true" />
        <h3>Restored File Ready</h3>
      </div>
      <p>
        {name} · {mime ?? "application/octet-stream"} · {file.size} bytes ·
        Integrity verified
      </p>
      <Button disabled={saving} onClick={() => void save()}>
        <ArchiveArrowDown width={17} height={17} aria-hidden="true" />
        {saving ? "Saving…" : "Save to Device"}
      </Button>{" "}
      <Button
        disabled={saving}
        variant="secondary"
        onClick={() => void discard()}
      >
        Discard Restored Copy
      </Button>
      <p role="status">{status}</p>
    </section>
  );
}
