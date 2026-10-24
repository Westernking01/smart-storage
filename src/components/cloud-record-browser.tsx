"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Folder from "@boxicons/react/Folder";
import { FileGlyph, filePresentation } from "./file-glyph";
import { displayBytes } from "@/lib/domain/display-bytes";
import Grid from "@boxicons/react/Grid";
import ListUl from "@boxicons/react/ListUl";
import DotsVertical from "@boxicons/react/DotsVertical";
import Search from "@boxicons/react/Search";
import { z } from "zod";
import {
  listenSessionChanges,
  notifySessionChange,
} from "@/lib/backend/session-events";
import {
  explorerListing,
  type folderRecord,
} from "@/lib/backend/explorer-contract";
import { useCloudRestoration } from "./cloud-restoration";
import { Button } from "./ui/button";

type FolderRow = z.infer<typeof folderRecord>;
export type RecordRow = {
  id: string;
  name: string;
  bytes: string;
  createdAt: string;
  originalName?: string;
  originalMime?: string | null;
  originalBytes?: string;
  revision?: number;
  category?: string;
  folderId?: string | null;
  locationRevision?: number;
};
type Directory = {
  folders: FolderRow[];
  breadcrumbs: FolderRow[];
  files: RecordRow[];
  next: number | null;
};
async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (response.status === 401) notifySessionChange();
  const value = await response.json();
  if (!response.ok)
    throw Error(
      typeof value?.error?.code === "string"
        ? value.error.code
        : "EXPLORER_OPERATION_FAILED",
    );
  return value;
}
async function directory(
  folder: string | null,
  query: string,
  sort: string,
  offset: number,
  signal: AbortSignal,
): Promise<Directory> {
  const params = new URLSearchParams({ query, sort, offset: String(offset) });
  if (folder) params.set("folder", folder);
  const data = explorerListing.parse(
    await request(`/api/file-explorer?${params}`, { signal }),
  );
  return {
    ...data,
    files: data.files.map(({ file, folderId, locationRevision }) => ({
      id: file.id,
      name: file.displayName,
      bytes: String(file.storedBytes ?? 0),
      createdAt: file.createdAt,
      originalName: file.originalName,
      originalMime: file.originalMime,
      originalBytes: String(file.originalBytes),
      revision: file.revision,
      category: file.category,
      folderId,
      locationRevision,
    })),
  };
}
export function CloudRecordBrowser({
  files,
  recent,
  ownerId,
  nextHref,
}: {
  files: RecordRow[];
  recent: boolean;
  ownerId?: string;
  nextHref?: string;
}) {
  const [query, setQuery] = useState(""),
    [sort, setSort] = useState(recent ? "date" : "name"),
    [folder, setFolder] = useState<string | null>(null),
    [view, setView] = useState("grid"),
    [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [data, setData] = useState<Directory>({
    files,
    folders: [],
    breadcrumbs: [],
    next: null,
  });
  const [ready, setReady] = useState(false),
    [active, setActive] = useState(true),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [message, setMessage] = useState("");
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<{
    kind: "create" | "folder" | "file";
    id?: string;
    name: string;
    revision?: number;
    category?: string;
  }>();
  const [move, setMove] = useState<{
    file: RecordRow;
    target: string | null;
    data: Directory;
  }>();
  const epoch = useRef(0),
    mounted = useRef(true),
    read = useRef<AbortController | null>(null),
    mutation = useRef(false);
  const restore = useCloudRestoration(ownerId ?? "unavailable");
  useEffect(() => {
    mounted.current = true;
    const fence = () => {
      epoch.current++;
      read.current?.abort();
    };
    const changed = () => {
      fence();
      setActive(false);
      setData({ files: [], folders: [], breadcrumbs: [], next: null });
      setEditor(undefined);
      setMove(undefined);
    };
    const stop = listenSessionChanges(changed);
    return () => {
      mounted.current = false;
      // Strict Mode replays effect setup/cleanup without changing the session.
      // Fence pending work on teardown; only session events invalidate the UI.
      fence();
      stop();
    };
  }, [ownerId]);
  useEffect(() => {
    if (!active || recent || !ownerId) return;
    const abort = new AbortController();
    read.current = abort;
    queueMicrotask(() => {
      if (!abort.signal.aborted) setLoading(true);
    });
    void directory(folder, query, sort, offset, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setData(value);
        setReady(true);
        setUncertain(false);
        setLoading(false);
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        setLoading(false);
        setReady(false);
        if (folder === null)
          setData({ files, folders: [], breadcrumbs: [], next: null });
        setMessage(
          error instanceof Error &&
            error.message === "FOLDER_BACKEND_UNAVAILABLE"
            ? "Persistent folders require the reviewed backend installation. Cloud records and restoration remain available."
            : "Folder metadata could not be loaded. No changes are assumed.",
        );
      });
    return () => abort.abort();
  }, [folder, query, sort, offset, version, active, recent, ownerId, files]);
  async function mutate(path: string, value: unknown, method = "POST") {
    if (mutation.current || !active || uncertain || loading) return;
    mutation.current = true;
    setBusy(true);
    const captured = epoch.current;
    try {
      await request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!mounted.current || captured !== epoch.current) return;
      setMessage("Metadata saved.");
      setEditor(undefined);
      setMove(undefined);
      setVersion((v) => v + 1);
    } catch {
      if (mounted.current && captured === epoch.current) {
        setUncertain(true);
        setMessage(
          "The change could not be confirmed. Refresh metadata before another change; no automatic retry was made.",
        );
      }
    } finally {
      mutation.current = false;
      if (mounted.current && captured === epoch.current) setBusy(false);
    }
  }
  async function browseTarget(target: string | null) {
    if (!move) return;
    const captured = epoch.current;
    setBusy(true);
    try {
      const value = await directory(
        target,
        "",
        "name",
        0,
        new AbortController().signal,
      );
      if (mounted.current && captured === epoch.current)
        setMove({ ...move, target, data: value });
    } catch {
      if (captured === epoch.current)
        setMessage("Destination could not be loaded.");
    } finally {
      if (mounted.current && captured === epoch.current) setBusy(false);
    }
  }
  const navigate = (id: string | null) => {
    setFolder(id);
    setQuery("");
    setOffset(0);
  };
  if (!active)
    return (
      <p role="status">Session changed. Refresh to load authorized records.</p>
    );
  const visible = (ready ? data.files : folder ? [] : files)
    .filter((f) => !query || f.name.toLowerCase().includes(query.toLowerCase()))
    .toSorted((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "type"
          ? (a.originalMime ?? "").localeCompare(b.originalMime ?? "")
          : sort === "size"
            ? BigInt(a.originalBytes ?? a.bytes) >
              BigInt(b.originalBytes ?? b.bytes)
              ? -1
              : BigInt(a.originalBytes ?? a.bytes) <
                  BigInt(b.originalBytes ?? b.bytes)
                ? 1
                : 0
            : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const selected = visible.find((f) => f.id === selectedId) ?? visible[0];
  return (
    <section className="cloud-explorer" aria-label="Cloud file explorer">
      <div className="workspace-tools">
        <label className="explorer-search">
          <Search width={18} height={18} aria-hidden="true" />
          <input
            className="ui-input"
            aria-label="Search cloud files and folders"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
            placeholder="Search files and folders"
          />
        </label>
        <select
          aria-label="Sort cloud files"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setOffset(0);
          }}
        >
          <option value="name">Name</option>
          <option value="type">Type</option>
          <option value="size">Size</option>
          <option value="date">Date</option>
        </select>
        <Button
          variant="secondary"
          aria-pressed={view === "list"}
          onClick={() => setView("list")}
        >
          <ListUl width={18} height={18} aria-hidden="true" />
          <span>List view</span>
        </Button>
        <Button
          variant="secondary"
          aria-pressed={view === "grid"}
          onClick={() => setView("grid")}
        >
          <Grid width={18} height={18} aria-hidden="true" />
          <span>Grid view</span>
        </Button>
        {!recent && (
          <Button
            disabled={!ready || busy || uncertain || loading}
            onClick={() => setEditor({ kind: "create", name: "" })}
          >
            <Folder width={18} height={18} aria-hidden="true" />
            New folder
          </Button>
        )}
      </div>
      {!recent && (
        <nav aria-label="Folder breadcrumbs">
          <button onClick={() => navigate(null)}>Root</button>
          {data.breadcrumbs.map((d) => (
            <span key={d.id}>
              {" "}
              / <button onClick={() => navigate(d.id)}>{d.name}</button>
            </span>
          ))}
        </nav>
      )}
      {query && (
        <p>
          {ready
            ? "Search across all folders"
            : "Search this cloud metadata page"}
        </p>
      )}
      <p role="status">{message}</p>
      {uncertain && (
        <Button
          variant="secondary"
          onClick={() => {
            setEditor(undefined);
            setMove(undefined);
            setLoading(true);
            setVersion((v) => v + 1);
          }}
        >
          Refresh metadata
        </Button>
      )}
      {loading && <p>Loading folder...</p>}
      {editor && (
        <form
          className="explorer-editor"
          aria-label="Name editor"
          onSubmit={(e) => {
            e.preventDefault();
            const name = editor.name.trim();
            if (
              !name ||
              /[\\/\u0000-\u001f]/.test(name) ||
              new TextEncoder().encode(name).length > 255 ||
              [".", ".."].includes(name)
            ) {
              setMessage("Enter a valid name of at most 255 bytes.");
              return;
            }
            if (editor.kind === "file")
              void mutate(
                `/api/files/${editor.id}`,
                {
                  displayName: name,
                  category: editor.category ?? "other",
                  revision: editor.revision ?? 0,
                },
                "PATCH",
              );
            else
              void mutate(
                "/api/file-explorer",
                editor.kind === "create"
                  ? {
                      action: "create",
                      id: crypto.randomUUID(),
                      parent: folder,
                      name,
                    }
                  : {
                      action: "rename",
                      id: editor.id,
                      name,
                      revision: editor.revision,
                    },
              );
          }}
        >
          <label>
            Name
            <input
              autoFocus
              className="ui-input"
              value={editor.name}
              disabled={busy}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            />
          </label>
          <Button type="submit" disabled={busy || uncertain || loading}>
            Save name
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setEditor(undefined)}
          >
            Cancel name edit
          </Button>
        </form>
      )}
      <div className="explorer-workspace">
        <div className="explorer-collection">
          {!loading && (
            <ul
              className={`explorer-entries explorer-entries--${view}`}
              aria-label="Folder contents"
            >
              {!recent &&
                data.folders
                  .toSorted((a, b) =>
                    sort === "date"
                      ? Date.parse(b.createdAt ?? "1970-01-01") -
                        Date.parse(a.createdAt ?? "1970-01-01")
                      : a.name.localeCompare(b.name),
                  )
                  .map((d) => (
                    <li key={d.id} className="explorer-entry explorer-folder">
                      <button
                        className="explorer-open"
                        onClick={() => navigate(d.id)}
                        onDoubleClick={() => navigate(d.id)}
                      >
                        <Folder aria-hidden width={32} height={32} />
                        <span title={d.name}>{d.name}</span>
                      </button>
                      <details className="file-action-menu">
                        <summary aria-label={`Actions for folder ${d.name}`}>
                          <DotsVertical width={19} height={19} />
                        </summary>
                        <div>
                          <Button
                            variant="secondary"
                            aria-label={`Rename folder ${d.name}`}
                            disabled={!ready || busy || uncertain}
                            onClick={() =>
                              setEditor({
                                kind: "folder",
                                id: d.id,
                                name: d.name,
                                revision: d.revision,
                              })
                            }
                          >
                            Rename folder
                          </Button>
                        </div>
                      </details>
                    </li>
                  ))}
              {visible.map((f) => (
                <li
                  key={f.id}
                  className={`explorer-entry${selected?.id === f.id ? " is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="explorer-select"
                    aria-label={`Select ${f.name}`}
                    aria-pressed={selected?.id === f.id}
                    onClick={() => setSelectedId(f.id)}
                  >
                    <FileGlyph
                      name={f.originalName ?? f.name}
                      mime={f.originalMime}
                    />
                    <span className="explorer-file-name">
                      <strong title={f.name}>{f.name}</strong>
                      <span className="file-meta">
                        {
                          filePresentation(
                            f.originalName ?? f.name,
                            f.originalMime,
                          ).label
                        }{" "}
                        · {displayBytes(f.originalBytes ?? f.bytes)}
                      </span>
                      <span className="explorer-date">
                        <time dateTime={f.createdAt}>
                          {new Date(f.createdAt).toLocaleDateString()}
                        </time>
                      </span>
                    </span>
                  </button>
                  <div className="local-actions">
                    {!recent && (
                      <details className="file-action-menu">
                        <summary aria-label={`Actions for ${f.name}`}>
                          <DotsVertical width={19} height={19} />
                        </summary>
                        <div>
                          <Button
                            aria-label={`Rename file ${f.name}`}
                            variant="secondary"
                            disabled={busy || uncertain}
                            onClick={() =>
                              setEditor({
                                kind: "file",
                                id: f.id,
                                name: f.name,
                                revision: f.revision,
                                category: f.category,
                              })
                            }
                          >
                            Rename
                          </Button>
                          <Button
                            aria-label={`Move file ${f.name}`}
                            variant="secondary"
                            disabled={!ready || busy || uncertain}
                            onClick={() =>
                              setMove({ file: f, target: folder, data })
                            }
                          >
                            Move
                          </Button>
                        </div>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!loading && !visible.length && !data.folders.length && (
            <div className="designed-empty">
              <Folder width={44} height={44} aria-hidden="true" />
              <h3>
                {query
                  ? "No matching files or folders."
                  : "This folder is empty."}
              </h3>
              <p>
                {query
                  ? "Try another name or browse from Root."
                  : "Create a folder to make room for your files."}
              </p>
            </div>
          )}
        </div>
        {selected && !loading && (
          <aside className="explorer-selection" aria-label="Selected file">
            <p className="type-caption">File details</p>
            <FileGlyph
              name={selected.originalName ?? selected.name}
              mime={selected.originalMime}
            />
            <h2 title={selected.name}>{selected.name}</h2>
            <dl>
              <div>
                <dt>Format</dt>
                <dd>
                  {
                    filePresentation(
                      selected.originalName ?? selected.name,
                      selected.originalMime,
                    ).label
                  }
                </dd>
              </div>
              <div>
                <dt>Original size</dt>
                <dd>
                  {displayBytes(selected.originalBytes ?? selected.bytes)}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <time dateTime={selected.createdAt}>
                    {new Date(selected.createdAt).toLocaleDateString()}
                  </time>
                </dd>
              </div>
            </dl>
            {ownerId && (
              <Button
                disabled={restore.busy}
                onClick={() =>
                  void restore.start({
                    id: selected.id,
                    name: selected.name,
                    originalName: selected.originalName ?? selected.name,
                    originalMime: selected.originalMime ?? null,
                  })
                }
              >
                Download and restore
              </Button>
            )}
            <Link href={`/app/files/${selected.id}`} prefetch={false}>
              Open file record
            </Link>
          </aside>
        )}
      </div>
      {ready && (
        <div className="local-actions">
          {offset > 0 && (
            <Button
              variant="secondary"
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous files
            </Button>
          )}
          {data.next !== null && (
            <Button variant="secondary" onClick={() => setOffset(data.next!)}>
              Next files
            </Button>
          )}
        </div>
      )}
      {!ready && nextHref && (
        <Link href={nextHref} prefetch={false}>
          Next 25 cloud records
        </Link>
      )}
      {move && (
        <section
          role="dialog"
          aria-modal="false"
          aria-label="Move file destination"
          className="explorer-editor"
        >
          <h3>Move {move.file.name}</h3>
          <nav aria-label="Destination breadcrumbs">
            <button disabled={busy} onClick={() => void browseTarget(null)}>
              Root
            </button>
            {move.data.breadcrumbs.map((d) => (
              <button
                key={d.id}
                disabled={busy}
                onClick={() => void browseTarget(d.id)}
              >
                {d.name}
              </button>
            ))}
          </nav>
          <ul>
            {move.data.folders.map((d) => (
              <li key={d.id}>
                <button disabled={busy} onClick={() => void browseTarget(d.id)}>
                  <Folder aria-hidden width={24} height={24} />
                  {d.name}
                </button>
              </li>
            ))}
          </ul>
          <Button
            disabled={busy || uncertain}
            onClick={() =>
              void mutate("/api/file-explorer", {
                action: "move",
                id: move.file.id,
                folder: move.target,
                revision: move.file.locationRevision ?? 0,
              })
            }
          >
            Move here
          </Button>
          <Button
            disabled={busy}
            variant="secondary"
            onClick={() => setMove(undefined)}
          >
            Cancel move
          </Button>
        </section>
      )}
      {restore.panel}
    </section>
  );
}
