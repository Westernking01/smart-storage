"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Search from "@boxicons/react/Search";
import File from "@boxicons/react/File";
import Folder from "@boxicons/react/Folder";
import ImageIcon from "@boxicons/react/Image";
import Music from "@boxicons/react/Music";
import Download from "@boxicons/react/ArchiveArrowDown";
import Edit from "@boxicons/react/Edit";
import Trash from "@boxicons/react/Trash";
import { SegmentedProgress } from "@/components/segmented-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listenSessionChanges } from "@/lib/backend/session-events";
import ArchiveArrowDown from "@boxicons/react/ArchiveArrowDown";
type LocalFile = {
  id: string;
  name: string;
  originalName: string;
  mime: string | null;
  phase: string;
  cloudPrepared?: boolean;
  verified?: boolean;
  codecs?: string[];
  createdAt: string | null;
  originalBytes: number;
  compressedBytes: number;
  uploadedBytes: number;
  attemptedTransferBytes: number;
};
type Sort = "name" | "size" | "date" | "savings";
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const savings = (f: LocalFile) =>
  f.originalBytes ? (f.originalBytes - f.compressedBytes) / f.originalBytes : 0;
const kind = (f: LocalFile) =>
  f.mime?.split("/")[0] ||
  f.originalName.split(".").pop()?.toLowerCase() ||
  "other";
const fileIcon = (file: LocalFile) => {
  const type = kind(file);
  return type === "image"
    ? ImageIcon
    : type === "audio"
      ? Music
      : type === "other"
        ? Folder
        : File;
};
const titleCase = (value: string) =>
  value ? `${value[0].toUpperCase()}${value.slice(1)}` : "Other";
export function LocalTransfer({
  ownerId,
  title = "Your local file workspace",
  mode = "all",
}: {
  ownerId?: string;
  title?: string;
  mode?: "all" | "files" | "compress" | "recent" | "storage";
} = {}) {
  const worker = useRef<Worker | null>(null),
    url = useRef<string | null>(null),
    input = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [source, setSource] = useState<File | null>(null);
  const [busy, setBusy] = useState(true),
    [message, setMessage] = useState("Loading local browser storage…"),
    [progress, setProgress] = useState(0);
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState<Sort>("date");
  const [download, setDownload] = useState<string | null>(null),
    [downloadName, setDownloadName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState("");
  const [locations, setLocations] = useState<Record<string, string>>({});
  const [capacity, setCapacity] = useState("Browser capacity unavailable.");
  useEffect(() => {
    void navigator.storage
      ?.estimate?.()
      .then((v) =>
        setCapacity(
          `Browser origin usage: ${bytes(v.usage ?? 0)}; origin quota: ${bytes(v.quota ?? 0)}. This is not physical device capacity.`,
        ),
      )
      .catch(() => {});
  }, [files]);
  const current = files.find((f) => f.id === selected) ?? null;
  useEffect(() => {
    if (typeof Worker !== "function" || !globalThis.indexedDB) {
      queueMicrotask(() => {
        setBusy(false);
        setMessage("This browser cannot run durable local staging.");
      });
      return;
    }
    const w = new Worker(
      new URL("../workers/local-transfer.worker.ts", import.meta.url),
    );
    worker.current = w;
    let active = true;
    const refresh = (announceRecovery = false) =>
      w.postMessage({ method: "list", ownerId, announceRecovery });
    w.onmessage = ({ data }) => {
      if (!active) return;
      if (typeof data.progress === "number") {
        setProgress(data.progress);
        setMessage(
          data.phase === "verifying"
            ? "Verifying exact restoration of prepared bytes..."
            : `${bytes(data.progress)} prepared locally.`,
        );
        return;
      }
      if (typeof data.restoreProgress === "number") {
        setProgress(data.restoreProgress);
        setMessage(`${bytes(data.restoreProgress)} restored and verified.`);
        return;
      }
      setBusy(false);
      if (data.error) {
        setMessage(`Stopped: ${data.error}. No cloud request was made.`);
        return;
      }
      if (data.result === "ready") refresh(true);
      if (data.result === "listed") {
        setFiles(data.files);
        setSelected((id) =>
          id && data.files.some((f: LocalFile) => f.id === id)
            ? id
            : (data.files[0]?.id ?? null),
        );
        if (data.announceRecovery)
          setMessage(
            data.files.length
              ? `${data.files.length} local staged ${data.files.length === 1 ? "file" : "files"} recovered.`
              : "No files are staged in this browser yet.",
          );
      }
      if (["prepared", "renamed", "deleted"].includes(data.result)) {
        if (data.result === "prepared") {
          setSource(null);
          if (input.current) input.current.value = "";
          setMessage(
            "Preparation and exact restoration verified locally. Nothing has been uploaded.",
          );
        } else
          setMessage(
            data.result === "renamed"
              ? "Local display name updated."
              : "Local staged file deleted.",
          );
        refresh();
      }
      if (data.result === "verified") {
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = URL.createObjectURL(data.file);
        setDownload(url.current);
        setDownloadName(data.downloadName);
        setMessage(
          "Exact restoration verified locally. Save the verified result below.",
        );
      }
    };
    w.onerror = () => {
      if (!active) return;
      setBusy(false);
      setMessage("Local worker stopped. Reload to inspect saved checkpoints.");
    };
    w.postMessage({ method: "ready", ownerId });
    const fence = () => {
      if (!active) return;
      active = false;
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
      if (worker.current === w) worker.current = null;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      setDownload(null);
      setSource(null);
      setSelected(null);
      setBusy(false);
      setFiles([]);
      setFolders([]);
      setLocations({});
      setFolder("");
      setMessage("Session changed. Local processing stopped.");
    };
    const unsubscribe = listenSessionChanges(fence);
    const localChanged = () => {
      if (!active) return;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      setDownload(null);
      refresh();
    };
    window.addEventListener("smart-storage-local-change", localChanged);
    return () => {
      window.removeEventListener("smart-storage-local-change", localChanged);
      unsubscribe();
      active = false;
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
      if (worker.current === w) worker.current = null;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
    };
  }, [ownerId]);
  const send = (method: string, extra: Record<string, unknown> = {}) => {
    if (!worker.current) return;
    setBusy(true);
    setProgress(0);
    setDownload(null);
    worker.current.postMessage({ method, ownerId, ...extra });
  };
  const visible = useMemo(
    () =>
      files
        .filter(
          (f) =>
            (mode !== "files" || (locations[f.id] ?? "") === folder) &&
            f.name.toLowerCase().includes(query.toLowerCase()) &&
            (filter === "all" || kind(f) === filter),
        )
        .sort((a, b) =>
          mode !== "recent" && sort === "name"
            ? a.name.localeCompare(b.name)
            : mode !== "recent" && sort === "size"
              ? b.originalBytes - a.originalBytes
              : mode !== "recent" && sort === "savings"
                ? savings(b) - savings(a)
                : (Date.parse(b.createdAt ?? "") || 0) -
                  (Date.parse(a.createdAt ?? "") || 0),
        ),
    [files, query, filter, sort, mode, locations, folder],
  );
  const metrics = useMemo(
    () =>
      files.reduce(
        (a, f) => ({
          count: a.count + 1,
          original: a.original + f.originalBytes,
          encoded: a.encoded + f.compressedBytes,
          verifiedOriginal:
            a.verifiedOriginal + (f.verified ? f.originalBytes : 0),
          verifiedEncoded:
            a.verifiedEncoded + (f.verified ? f.compressedBytes : 0),
        }),
        {
          count: 0,
          original: 0,
          encoded: 0,
          verifiedOriginal: 0,
          verifiedEncoded: 0,
        },
      ),
    [files],
  );
  const types = [...new Set(files.map(kind))].sort(),
    pct = metrics.verifiedOriginal
      ? Math.max(
          0,
          ((metrics.verifiedOriginal - metrics.verifiedEncoded) /
            metrics.verifiedOriginal) *
            100,
        )
      : 0;
  return (
    <section
      className={`local-workspace local-workspace--${mode}`}
      aria-busy={busy}
      id="recent-files"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!busy && mode === "all") setSource(e.dataTransfer.files[0] ?? null);
      }}
    >
      <header className="workspace-heading">
        <div>
          <p className="type-caption">
            {mode === "all"
              ? "Your storage, at a glance"
              : "Local browser storage"}
          </p>
          <h1 className="type-page">{title}</h1>
          <p>
            {mode === "compress"
              ? "Prepared compressed files, integrity evidence and upload status. Choose originals on Overview."
              : mode === "recent"
                ? "Newest staged records first. Only recorded staging timestamps are shown; this is not a transfer-history audit."
                : mode === "storage"
                  ? "Manage staged files and inspect actual local payload totals. Browser storage can be evicted."
                  : mode === "files"
                    ? "Local-only prepared files are separate from authorized cloud files below."
                    : "Compress, organize, and restore files on this device. These local actions do not send cloud requests."}
          </p>
        </div>
        {mode === "all" && (
          <label
            className="ui-button ui-button--primary local-picker"
            id="add-local-file"
          >
            <span className="picker-icon">
              <ArchiveArrowDown width={24} height={24} />
            </span>
            <span>
              <strong>Choose original file</strong>
              <small>Or drop it in this workspace</small>
            </span>
            <Input
              ref={input}
              type="file"
              aria-label="Original file"
              disabled={busy}
              onChange={(e) => setSource(e.target.files?.[0] ?? null)}
            />
          </label>
        )}
      </header>
      {source && mode === "all" && (
        <div className="prepare-bar">
          <span>
            <strong>{source.name}</strong> · {bytes(source.size)}
          </span>
          <Button
            disabled={busy}
            onClick={() => send("prepare", { file: source })}
          >
            Prepare locally
          </Button>
        </div>
      )}
      {(mode === "all" || mode === "storage" || mode === "compress") && (
        <div
          className={`file-stat-strip${mode === "all" ? " overview-kpis" : ""}`}
          id="storage-metrics"
          aria-label="Local browser storage metrics"
        >
          {mode === "all" && (
            <article className="kpi-lead">
              <span>Verified prepared savings</span>
              <strong>
                {busy && !files.length ? "—" : `${pct.toFixed(1)}%`}
              </strong>
              <small>Original bytes preserved</small>
            </article>
          )}
          <article>
            <span>Staged files</span>
            <strong>{busy && !files.length ? "—" : metrics.count}</strong>
          </article>
          <article>
            <span>Original size</span>
            <strong>
              {busy && !files.length ? "—" : bytes(metrics.original)}
            </strong>
          </article>
          <article>
            <span>Encoded size</span>
            <strong>
              {busy && !files.length ? "—" : bytes(metrics.encoded)}
            </strong>
          </article>
          {mode !== "all" && (
            <article>
              <span>Verified prepared savings</span>
              <strong>
                {busy && !files.length ? "—" : `${pct.toFixed(1)}%`}
              </strong>
            </article>
          )}
          {mode === "all" && (
            <div className="kpi-comparison">
              <SegmentedProgress
                value={pct}
                segments={100}
                label={`${pct.toFixed(1)} percent verified payload savings`}
              />
              <span>
                Verified savings across locally prepared files · encoded payload
                sizes exclude cloud manifests
              </span>
            </div>
          )}
        </div>
      )}
      {
        <div className="workspace-tools">
          <label>
            <span className="sr-only">Search local files</span>
            <Search width={18} height={18} />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search local files"
            />
          </label>
          <select
            aria-label="Filter by file type"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort local files"
            disabled={mode === "recent"}
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <option value="date">Newest</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="savings">Savings</option>
          </select>
          {(query || filter !== "all" || sort !== "date") && (
            <button
              type="button"
              className="clear-file-filters"
              onClick={() => {
                setQuery("");
                setFilter("all");
                setSort("date");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      }
      {mode === "storage" && <p>{capacity}</p>}
      {mode === "files" && (
        <div className="workspace-tools">
          <p>
            Local-only organization for this visit. Cloud folder and move
            contracts are unavailable.
          </p>
          <Button
            onClick={() => {
              const name = prompt("New folder name");
              if (name?.trim() && !name.includes("/"))
                setFolders((all) => [
                  ...new Set([
                    ...all,
                    folder ? `${folder}/${name.trim()}` : name.trim(),
                  ]),
                ]);
            }}
          >
            New folder
          </Button>
          <select
            aria-label="Open folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            <option value="">Root</option>
            {folders.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          {current && (
            <select
              aria-label="Move local file"
              value={locations[current.id] ?? ""}
              onChange={(e) =>
                setLocations({ ...locations, [current.id]: e.target.value })
              }
            >
              <option value="">Root</option>
              {folders.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          )}
        </div>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
      {busy && (
        <Button
          variant="secondary"
          onClick={() => worker.current?.postMessage({ method: "cancel" })}
        >
          Cancel local operation
        </Button>
      )}
      {busy && (
        <progress
          aria-label="Local operation progress"
          value={progress || undefined}
          max={source?.size || current?.originalBytes || 1}
        />
      )}
      <div
        className={
          mode === "recent" ? "recent-file-workspace" : "file-workspace-grid"
        }
      >
        <div className="local-file-list" aria-label="Local staged files">
          {visible.length === 0 ? (
            <div className="local-empty">
              <File width={34} height={34} />
              <h2 className="type-section">
                {files.length
                  ? "No files match"
                  : "Your local workspace is empty"}
              </h2>
              <p>
                {files.length
                  ? "Change the search or filter."
                  : "Choose a file to compress and stage it securely in this browser."}
              </p>
              {mode !== "all" && (
                <Link href="/">Prepare an original on Overview</Link>
              )}
            </div>
          ) : (
            <>
              <div className="local-file-table-heading" aria-hidden="true">
                <span>Name</span>
                <span>Type</span>
                <span>Original</span>
                <span>Encoded</span>
                <span>Savings</span>
                <span>Status</span>
              </div>
              {visible.map((f) => {
                const Icon = fileIcon(f);
                const Row = mode === "recent" ? "div" : "button";
                return (
                  <Row
                    key={f.id}
                    className={
                      mode !== "recent" && selected === f.id
                        ? "local-file-row is-selected"
                        : "local-file-row"
                    }
                    aria-label={
                      mode === "recent"
                        ? `Local file ${f.name}`
                        : `View details for ${f.name}`
                    }
                    title={f.name}
                    onClick={
                      mode === "recent" ? undefined : () => setSelected(f.id)
                    }
                  >
                    <span className="file-type-icon" aria-hidden="true">
                      <Icon width={20} height={20} />
                    </span>
                    <span className="file-name-cell">
                      <strong>{f.name}</strong>
                      <small>{f.mime ?? "Unknown type"} · Local staged</small>
                      {mode === "recent" && (
                        <small>
                          {f.createdAt ? (
                            <time dateTime={f.createdAt}>
                              {new Date(f.createdAt).toLocaleString()}
                            </time>
                          ) : (
                            "Timestamp unavailable"
                          )}{" "}
                          · Staged locally
                        </small>
                      )}
                    </span>
                    <span className="file-kind-cell">{titleCase(kind(f))}</span>
                    <span>{bytes(f.originalBytes)}</span>
                    <span>{bytes(f.compressedBytes)}</span>
                    <span>{(savings(f) * 100).toFixed(1)}%</span>
                    <span className="ui-badge">
                      {f.phase === "completed"
                        ? "Completed checkpoint"
                        : f.attemptedTransferBytes
                          ? "Unresolved transfer"
                          : f.phase === "prepared"
                            ? "Prepared"
                            : f.phase}
                    </span>
                    {mode === "recent" && (
                      <Link href="/local-storage">Manage local file</Link>
                    )}
                  </Row>
                );
              })}
            </>
          )}
        </div>
        {mode !== "recent" && (
          <aside className="local-details" aria-label="File details">
            {current ? (
              <>
                <p className="type-caption">File details</p>
                <div className="details-file-heading">
                  <span className="details-file-icon" aria-hidden="true">
                    {kind(current) === "image" ? (
                      <ImageIcon width={26} height={26} />
                    ) : kind(current) === "audio" ? (
                      <Music width={26} height={26} />
                    ) : kind(current) === "other" ? (
                      <Folder width={26} height={26} />
                    ) : (
                      <File width={26} height={26} />
                    )}
                  </span>
                  <div>
                    <h2 className="type-section" title={current.name}>
                      {current.name}
                    </h2>
                    <p>{current.mime ?? "Unknown type"}</p>
                  </div>
                </div>
                <div className="details-savings">
                  <div>
                    <span>
                      {current.verified
                        ? "Verified savings"
                        : "Size difference (verification unavailable)"}
                    </span>
                    <strong>{(savings(current) * 100).toFixed(1)}%</strong>
                  </div>
                  <SegmentedProgress
                    value={savings(current) * 100}
                    label={`${(savings(current) * 100).toFixed(1)} percent savings for ${current.name}`}
                    segments={20}
                  />
                </div>
                <div
                  className="details-metadata"
                  role="list"
                  aria-label="File metadata"
                >
                  <div role="listitem">
                    <span className="detail-label">Original filename</span>
                    <span className="detail-value" title={current.originalName}>
                      {current.originalName}
                    </span>
                  </div>
                  <div role="listitem">
                    <span className="detail-label">Original size</span>
                    <span className="detail-value">
                      {bytes(current.originalBytes)}
                    </span>
                  </div>
                  <div role="listitem">
                    <span className="detail-label">Encoded size</span>
                    <span className="detail-value">
                      {bytes(current.compressedBytes)}
                    </span>
                  </div>
                  <div role="listitem">
                    <span className="detail-label">Storage location</span>
                    <span className="detail-value">Local browser storage</span>
                  </div>
                  <div role="listitem">
                    <span className="detail-label">Preparation</span>
                    <span className="detail-value">{current.phase}</span>
                  </div>
                </div>
                <p>
                  Saved bytes: {current.originalBytes - current.compressedBytes}{" "}
                  B · Codec: {current.codecs?.join(", ") || "Unavailable"} ·
                  Verification:{" "}
                  {current.verified
                    ? "Restoration verified at preparation"
                    : "Unavailable"}
                </p>
                <div className="detail-actions">
                  {(mode === "compress" || mode === "all") &&
                    ownerId &&
                    current.cloudPrepared &&
                    !busy && (
                      <Link
                        className="ui-button ui-button--primary"
                        href={`/compress?prepared=${current.id}#cloud-heading`}
                        prefetch={false}
                      >
                        Upload to Cloud
                      </Link>
                    )}
                  <Button
                    disabled={busy || current.phase !== "prepared"}
                    onClick={() => send("restore", { id: current.id })}
                  >
                    <Download width={17} height={17} />
                    Restore &amp; verify
                  </Button>
                  {mode !== "compress" && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          const name = prompt(
                            "Local display name",
                            current.name,
                          );
                          if (name && name !== current.name)
                            send("rename", {
                              id: current.id,
                              displayName: name,
                            });
                        }}
                      >
                        <Edit width={17} height={17} />
                        Rename
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              `Delete ${current.name} from local browser storage?`,
                            )
                          )
                            send("delete", { id: current.id });
                        }}
                      >
                        <Trash width={17} height={17} />
                        Delete local file
                      </Button>
                    </>
                  )}
                  {download && selected === current.id && (
                    <a
                      className="ui-button ui-button--secondary"
                      href={download}
                      download={downloadName}
                    >
                      Save verified original bytes
                    </a>
                  )}
                </div>
              </>
            ) : (
              <div className="local-empty">
                <File width={32} height={32} />
                <p>Select a local file to inspect it.</p>
              </div>
            )}
          </aside>
        )}
      </div>
      <p className="type-metadata">
        Maximum 32 MiB per file. Encoded bytes remain on this device and may be
        evicted by the browser. Exact restoration verifies every block and the
        complete SHA-256 digest.
      </p>
      <p>
        <Link href="/">Back to overview</Link>
      </p>
    </section>
  );
}
