"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { type OwnedFile } from "@/lib/backend/files";
import { fileEdit } from "@/lib/backend/schemas";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
export function FileEditor({ file }: { file: OwnedFile }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    router = useRouter();
  async function submit(input?: unknown) {
    setBusy(true);
    try {
      const result = await fetch(`/api/files/${file.id}`, {
        method: input ? "PATCH" : "DELETE",
        headers: { "Content-Type": "application/json" },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (!result.ok) {
        setMessage(
          "The change was not applied. Refresh the file and try again.",
        );
        return;
      }
      if (!input) {
        dialog.current?.close();
        router.push("/app");
      } else setMessage("Metadata updated.");
      router.refresh();
    } catch {
      setMessage("The request stopped. Refresh to inspect the actual state.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          const fields = new FormData(e.currentTarget);
          const input = fileEdit.safeParse({
            displayName: fields.get("displayName"),
            category: fields.get("category"),
            revision: file.revision,
          });
          if (!input.success) {
            setMessage("Use a valid filename and category.");
            return;
          }
          void submit(input.data);
        }}
      >
        <label htmlFor="file-name">Display name</label>
        <Input
          id="file-name"
          name="displayName"
          defaultValue={file.displayName}
          required
          disabled={busy}
        />
        <label htmlFor="file-category">Category</label>
        <select
          id="file-category"
          name="category"
          defaultValue={file.category}
          disabled={busy}
          className="ui-input"
        >
          {["document", "image", "video", "audio", "archive", "other"].map(
            (c) => (
              <option key={c}>{c}</option>
            ),
          )}
        </select>
        <Button type="submit" disabled={busy}>
          Save metadata
        </Button>
      </form>
      <p role="status">{message}</p>
      <Button
        variant="danger"
        disabled={busy}
        onClick={() => dialog.current?.showModal()}
      >
        Delete file
      </Button>
      <dialog ref={dialog} aria-labelledby="delete-title">
        <h2 id="delete-title">Delete this file?</h2>
        <p>
          The file will be hidden immediately. Physical removal and quota
          release remain pending verified cleanup.
        </p>
        <div className="local-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            Keep file
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void submit()}
          >
            Confirm deletion
          </Button>
        </div>
      </dialog>
    </>
  );
}
