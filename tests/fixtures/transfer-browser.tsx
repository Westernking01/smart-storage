import { CloudRecordBrowser } from "../../src/components/cloud-record-browser";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { VolumeFiles } from "../../src/components/volume-files";
import { LocalTransfer } from "../../src/components/local-transfer";
import { ScopedStaging } from "../../src/lib/transfers/scoped-store";
import { prepare } from "../../src/lib/transfers/prepare";
import { canonical } from "../../src/lib/transfers/format";
import { digest } from "../../src/lib/transfers/codec";
import { IndexedStaging } from "../../src/lib/transfers/store";

export const root = createRoot(document.getElementById("root")!);
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let checkpoint: Awaited<ReturnType<typeof prepare>>;
let bytes: Blob;
let release: (() => void) | undefined;
let blocked = "";
let reached = "";
let puts = 0;
let publications = 0;
let refreshes = 0;
let cancelled = 0;
let mounts = 0;
let unauthorized = false;
let empty = false;
let failed = false;
let allocationDenied = false;
let publicationDenied = false;
let quota = "10000";
type TestFolder = {
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
};
const explorerState = JSON.parse(
  localStorage.getItem("offline-explorer") ??
    '{"folders":[],"folderId":null,"locationRevision":0,"name":"fixture.txt","revision":0}',
) as {
  folders: TestFolder[];
  folderId: string | null;
  locationRevision: number;
  name: string;
  revision: number;
};
const persistExplorer = () =>
  localStorage.setItem("offline-explorer", JSON.stringify(explorerState));
const remembered = sessionStorage.getItem("offline-cloud-fixture");
if (remembered) {
  const value = JSON.parse(remembered);
  checkpoint = value.checkpoint;
  bytes = new Blob([new Uint8Array(value.bytes)]);
}
function explorerFiles() {
  return [
    {
      file: {
        id: fileId,
        displayName: explorerState.name,
        originalName: "fixture.txt",
        originalMime: "text/plain",
        category: "document",
        state: "ready",
        originalBytes: String(checkpoint.originalBytes),
        encodedBytes: String(bytes.size),
        manifestBytes: "1",
        storedBytes: "100",
        createdAt: "2026-10-24T00:00:00Z",
        revision: explorerState.revision,
      },
      folderId: explorerState.folderId,
      locationRevision: explorerState.locationRevision,
    },
  ];
}
const listing = () => ({
  files: empty
    ? []
    : [
        {
          id: fileId,
          sessionId: fileId,
          originalName: "fixture.txt",
          originalMime: "text/plain",
          storedBytes: "100",
        },
      ],
  account: {
    usage: { storedBytes: "100", reservedBytes: "0", quotaBytes: quota },
  },
});
async function gate(stage: string) {
  if (stage !== blocked) return;
  reached = stage;
  await new Promise<void>((resolve) => {
    release = resolve;
  });
}
// Deliberately ignore AbortSignal: exercise late callbacks even when a transport
// cannot retract an already dispatched request. Nothing leaves this document.
window.fetch = async (_input, init) => {
  const requestUrl = new URL(String(_input), location.origin);
  if (requestUrl.pathname === "/api/file-explorer") {
    const command = init?.body ? JSON.parse(String(init.body)) : null;
    if (command) {
      if (command.action === "create")
        explorerState.folders.push({
          id: command.id,
          name: command.name,
          parentId: command.parent,
          revision: 0,
        });
      if (command.action === "rename") {
        const folder = explorerState.folders.find((d) => d.id === command.id)!;
        folder.name = command.name;
        folder.revision++;
      }
      if (command.action === "move") {
        explorerState.folderId = command.folder;
        explorerState.locationRevision++;
      }
      persistExplorer();
      return Response.json({ ok: true });
    }
    const folder = requestUrl.searchParams.get("folder"),
      query = requestUrl.searchParams.get("query") ?? "";
    const breadcrumbs: TestFolder[] = [];
    let entry = explorerState.folders.find((d) => d.id === folder);
    while (entry) {
      breadcrumbs.unshift(entry);
      entry = explorerState.folders.find((d) => d.id === entry!.parentId);
    }
    return Response.json({
      folders: explorerState.folders.filter((d) =>
        query
          ? d.name.toLowerCase().includes(query.toLowerCase())
          : d.parentId === folder,
      ),
      breadcrumbs,
      files: explorerFiles().filter((f) =>
        query
          ? f.file.displayName.toLowerCase().includes(query.toLowerCase())
          : f.folderId === folder,
      ),
      next: null,
    });
  }
  if (
    requestUrl.pathname.startsWith("/api/files/") &&
    init?.method === "PATCH"
  ) {
    const command = JSON.parse(String(init.body));
    explorerState.name = command.displayName;
    explorerState.revision++;
    persistExplorer();
    return Response.json(explorerFiles()[0].file);
  }
  if (failed)
    return Response.json(
      { error: { code: "CLOUD_REQUEST_FAILED" } },
      { status: 503 },
    );
  if (unauthorized)
    return Response.json(
      { error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  if (init?.method === "PUT") {
    puts++;
    await gate("write");
    return Response.json({ offset: bytes.size });
  }
  const command =
    init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (command) {
    if (allocationDenied && command.action === "begin")
      return Response.json(
        { error: { code: "CLOUD_STORAGE_AUTHORITY_DISABLED" } },
        { status: 503 },
      );
    await gate(command.action);
    if (command.action === "begin")
      return Response.json({ fileId, permits: { "0": "mock-permit" } });
    if (command.action === "verify")
      return Response.json({
        encodedBytes: bytes.size,
        encodedSha256: checkpoint.blocks[0].block.encodedSha256,
      });
    if (command.action === "publish") {
      publications++;
      if (publicationDenied)
        return Response.json(
          { error: { code: "CLOUD_TRUSTED_RPC_UNAVAILABLE" } },
          { status: 503 },
        );
      return Response.json({
        published: true,
        manifestSha256: digest(
          new TextEncoder().encode(canonical(checkpoint.manifest)),
        ),
        originalSha256: checkpoint.sourceSha256,
      });
    }
  }
  const path = String(_input);
  if (path.includes("/blocks/")) {
    await gate("stream");
    return new Response(
      new ReadableStream({
        start(controller) {
          if (blocked !== "reading") {
            void bytes.arrayBuffer().then((b) => {
              controller.enqueue(new Uint8Array(b));
              controller.close();
            });
          } else reached = "reading";
        },
        cancel() {
          cancelled++;
        },
      }),
    );
  }
  if (path.includes("?key=")) {
    await gate("receipt");
    return Response.json({
      published: true,
      manifestSha256: digest(
        new TextEncoder().encode(canonical(checkpoint.manifest)),
      ),
      originalSha256: checkpoint.sourceSha256,
    });
  }
  if (path.includes("?id="))
    return Response.json({ manifest: checkpoint.manifest });
  await gate("listing");
  return Response.json(listing());
};
Object.assign(window, {
  transferHarness: {
    A,
    B,
    async seed() {
      const scoped = await ScopedStaging.open(
        { kind: "account", ownerId: A },
        () => A,
        "cloud-offline",
      );
      try {
        checkpoint = await prepare(
          new Blob(["browser fixture ".repeat(1000)]),
          scoped.store,
          undefined,
          undefined,
          undefined,
          { originalName: "fixture.txt", originalMime: "text/plain" },
        );
        bytes = await scoped.store.block(checkpoint.id, 0);
        sessionStorage.setItem(
          "offline-cloud-fixture",
          JSON.stringify({
            checkpoint,
            bytes: [...new Uint8Array(await bytes.arrayBuffer())],
          }),
        );
      } finally {
        scoped.close();
      }
    },
    async seedPicker() {
      const scoped = await ScopedStaging.open(
        { kind: "account", ownerId: A },
        () => A,
      );
      try {
        checkpoint = await prepare(
          new Blob(["browser fixture ".repeat(1000)]),
          scoped.store,
          undefined,
          undefined,
          undefined,
          { originalName: "fixture.txt", originalMime: "text/plain" },
        );
        bytes = await scoped.store.block(checkpoint.id, 0);
      } finally {
        scoped.close();
      }
    },
    mount(
      owner = A,
      local = false,
      mode: "all" | "files" | "compress" | "recent" | "storage" = "all",
    ) {
      mounts++;
      root.render(
        local ? (
          <LocalTransfer
            ownerId={owner}
            mode={mode}
            title={mode === "all" ? undefined : mode}
          />
        ) : (
          <VolumeFiles ownerId={owner} cloudScope="offline" />
        ),
      );
    },
    mountRecords() {
      root.render(
        <CloudRecordBrowser
          recent={false}
          files={[
            {
              id: fileId,
              name: "fixture.txt",
              bytes: "100",
              createdAt: "2026-10-24T00:00:00Z",
            },
          ]}
        />,
      );
    },
    mountExplorer(owner = A) {
      root.render(
        <CloudRecordBrowser
          key={owner}
          ownerId={owner}
          recent={false}
          files={[
            {
              id: fileId,
              name: explorerState.name,
              originalName: "fixture.txt",
              originalMime: "text/plain",
              bytes: "100",
              createdAt: "2026-10-24T00:00:00Z",
              revision: explorerState.revision,
              category: "document",
            },
          ]}
        />,
      );
    },
    mountExplorerStrict() {
      root.render(
        <StrictMode>
          <CloudRecordBrowser
            ownerId={A}
            recent={false}
            files={[
              {
                id: fileId,
                name: "fixture.txt",
                originalName: "fixture.txt",
                originalMime: "text/plain",
                bytes: "100",
                createdAt: "2026-10-24T00:00:00Z",
              },
            ]}
          />
        </StrictMode>,
      );
    },
    async removeLocalStaging() {
      for (const name of [
        `smart-storage-account-staging-v1-${A}`,
        `smart-storage-account-staging-v1-${A}-cloud-offline`,
      ]) {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(Error("TEST_DELETE_FAILED"));
          request.onblocked = () => reject(Error("TEST_DELETE_BLOCKED"));
        });
      }
    },
    unmount() {
      root.render(null);
    },
    block(stage: string) {
      blocked = stage;
      reached = "";
    },
    release() {
      blocked = "";
      release?.();
      release = undefined;
    },
    stats() {
      return {
        reached,
        puts,
        publications,
        refreshes,
        cancelled,
        mounts,
        checkpointId: checkpoint?.id,
      };
    },
    async localPayloads(namespace?: string) {
      const scoped = await ScopedStaging.open(
        { kind: "account", ownerId: A },
        () => A,
        namespace,
      );
      try {
        const records = await scoped.store.list();
        let available = 0;
        for (const c of records) {
          try {
            await scoped.store.block(c.id, 0);
            available++;
          } catch {
            /* removed */
          }
        }
        return {
          available,
          retained: records.length,
          removed: records.filter((c) => c.localPayloadRemoved).length,
        };
      } finally {
        scoped.close();
      }
    },
    async cleanupAgain() {
      const scoped = await ScopedStaging.open(
        { kind: "account", ownerId: A },
        () => A,
        "cloud-offline",
      );
      try {
        const c = await scoped.store.load(checkpoint.id);
        const before = c.revision;
        await scoped.store.releasePublishedPayload(c);
        return { before, after: (await scoped.store.load(c.id)).revision };
      } finally {
        scoped.close();
      }
    },
    async crossOwnerCleanup() {
      const scoped = await ScopedStaging.open(
        { kind: "account", ownerId: A },
        () => A,
        "cloud-offline",
      );
      try {
        const c = await scoped.store.load(checkpoint.id);
        try {
          await scoped.store.releasePublishedPayload({
            ...c,
            phase: "completed",
            ownerId: B,
          });
        } catch {
          return "DENIED";
        }
        return "UNEXPECTED";
      } finally {
        scoped.close();
      }
    },
    failCleanup() {
      IndexedStaging.prototype.releasePublishedPayload = async () => {
        throw Error("LOCAL_CLEANUP_PENDING");
      };
    },
    denyPublication() {
      publicationDenied = true;
    },
    corruptDownload() {
      bytes = new Blob([new Uint8Array(bytes.size).fill(7)]);
    },
    refresh() {
      refreshes++;
    },
    empty() {
      empty = true;
    },
    fail() {
      failed = true;
    },
    invalidate() {
      unauthorized = true;
    },
    denyAllocation() {
      allocationDenied = true;
    },
    exhaustQuota() {
      quota = "100";
    },
  },
});
