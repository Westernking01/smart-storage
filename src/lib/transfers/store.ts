import { fail } from "./format";
import { canonical } from "./format";
import {
  envelope,
  openEnvelope,
  UUID,
  validateTransition,
  type Checkpoint,
} from "./checkpoint";
export interface StagingStore {
  load(id: string): Promise<Checkpoint>;
  save(
    c: Checkpoint,
    expectedRevision: number | null,
    staged?: { index: number; blob: Blob },
  ): Promise<void>;
  block(id: string, index: number): Promise<Blob>;
  list?(): Promise<Checkpoint[]>;
  rename?(id: string, displayName: string): Promise<Checkpoint>;
  delete?(id: string): Promise<void>;
  releasePublishedPayload?(receipt: Checkpoint): Promise<void>;
}
export class IndexedStaging implements StagingStore {
  private constructor(private db: IDBDatabase) {}
  static async open(
    name = "smart-storage-local-staging-v1",
    factory = globalThis.indexedDB,
  ): Promise<IndexedStaging> {
    if (!factory) fail("STAGING_UNSUPPORTED");
    return new Promise((resolve, reject) => {
      const r = factory.open(name, 1);
      r.onupgradeneeded = (event) => {
        if (event.oldVersion !== 0) {
          r.transaction?.abort();
          return;
        }
        r.result.createObjectStore("checkpoints");
        r.result.createObjectStore("blocks");
      };
      r.onblocked = () => reject(Error("STAGING_UPGRADE_BLOCKED"));
      r.onerror = () => reject(Error("STAGING_OPEN_FAILED"));
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        resolve(new IndexedStaging(r.result));
      };
    });
  }
  close() {
    this.db.close();
  }
  private transaction(mode: IDBTransactionMode) {
    try {
      return this.db.transaction(["checkpoints", "blocks"], mode, {
        durability: "strict",
      });
    } catch {
      return fail("STAGING_TRANSACTION_UNSUPPORTED");
    }
  }
  async load(id: string): Promise<Checkpoint> {
    if (!UUID.test(id)) fail("UPLOAD_ID_INVALID");
    return new Promise((resolve, reject) => {
      const tx = this.transaction("readonly");
      const r = tx.objectStore("checkpoints").get(id);
      let value: Checkpoint;
      r.onsuccess = () => {
        try {
          value = openEnvelope(r.result);
          if (value.id !== id) fail("CHECKPOINT_ID_MISMATCH");
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(Error("CHECKPOINT_MISSING_OR_CORRUPT"));
      tx.onerror = () => {};
    });
  }
  async save(
    c: Checkpoint,
    expected: number | null,
    staged?: { index: number; blob: Blob },
  ) {
    const value = envelope(c); // Hash before transaction; never await inside IDB callbacks.
    if (c.revision !== (expected === null ? 0 : expected + 1))
      fail("CHECKPOINT_REVISION_INVALID");
    if (
      staged &&
      staged.blob.size !== c.blocks[staged.index]?.block.encodedBytes
    )
      fail("STAGED_LENGTH_INVALID");
    return new Promise<void>((resolve, reject) => {
      const tx = this.transaction("readwrite");
      let code = "STAGING_WRITE_FAILED";
      const checkpoints = tx.objectStore("checkpoints");
      const r = checkpoints.get(c.id);
      r.onsuccess = () => {
        try {
          if (
            expected === null
              ? r.result !== undefined
              : openEnvelope(r.result).revision !== expected
          )
            fail("CHECKPOINT_CONFLICT");
          if (expected !== null) validateTransition(openEnvelope(r.result), c);
          checkpoints.put(value, c.id);
          if (staged)
            tx.objectStore("blocks").put(staged.blob, [c.id, staged.index]);
        } catch (e) {
          code =
            e instanceof DOMException && e.name === "QuotaExceededError"
              ? "STAGING_QUOTA_EXCEEDED"
              : e instanceof Error
                ? e.message
                : "CHECKPOINT_CONFLICT";
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        if (tx.error?.name === "QuotaExceededError")
          code = "STAGING_QUOTA_EXCEEDED";
      };
      tx.onabort = () =>
        reject(
          Error(
            tx.error?.name === "QuotaExceededError"
              ? "STAGING_QUOTA_EXCEEDED"
              : code,
          ),
        );
    });
  }
  async block(id: string, index: number): Promise<Blob> {
    if ((await this.load(id)).localPayloadRemoved)
      fail("LOCAL_PAYLOAD_REMOVED");
    return new Promise((resolve, reject) => {
      const tx = this.transaction("readonly");
      const r = tx.objectStore("blocks").get([id, index]);
      r.onsuccess = () => {
        if (!(r.result instanceof Blob)) tx.abort();
      };
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = () => reject(Error("STAGED_DATA_MISSING"));
      tx.onerror = () => {};
    });
  }
  async list(): Promise<Checkpoint[]> {
    return new Promise((resolve, reject) => {
      const tx = this.transaction("readonly");
      const request = tx.objectStore("checkpoints").getAll();
      let values: Checkpoint[] = [];
      request.onsuccess = () => {
        try {
          values = request.result.map(openEnvelope);
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(values);
      tx.onabort = () => reject(Error("STAGING_LIST_CORRUPT"));
      tx.onerror = () => {};
    });
  }
  async rename(id: string, displayName: string): Promise<Checkpoint> {
    const name = String(displayName);
    const current = await this.load(id);
    const next = {
      ...current,
      revision: current.revision + 1,
      displayName: name,
    };
    await this.save(next, current.revision);
    return next;
  }
  async delete(id: string): Promise<void> {
    if (!UUID.test(id)) fail("UPLOAD_ID_INVALID");
    return new Promise((resolve, reject) => {
      const tx = this.transaction("readwrite");
      const checkpoints = tx.objectStore("checkpoints");
      const request = checkpoints.get(id);
      request.onsuccess = () => {
        try {
          const checkpoint = openEnvelope(request.result);
          checkpoints.delete(id);
          for (const progress of checkpoint.blocks)
            tx.objectStore("blocks").delete([id, progress.block.index]);
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(Error("STAGING_DELETE_FAILED"));
      tx.onerror = () => {};
    });
  }
  // Explicit local-only GC retains metadata/counters. Never releases server quota.
  async releasePublishedPayload(receipt: Checkpoint) {
    if (receipt.phase !== "completed" || !receipt.ownerId || !receipt.manifest)
      fail("LOCAL_DISCARD_UNSAFE");
    return new Promise<void>((resolve, reject) => {
      const tx = this.transaction("readwrite");
      const checkpoints = tx.objectStore("checkpoints");
      const request = checkpoints.get(receipt.id);
      request.onsuccess = () => {
        try {
          const c = openEnvelope(request.result);
          if (
            c.ownerId !== receipt.ownerId ||
            c.sourceSha256 !== receipt.sourceSha256 ||
            canonical(c.manifest) !== canonical(receipt.manifest) ||
            canonical(c.metadata) !== canonical(receipt.metadata) ||
            !(
              c.phase === "completed" ||
              (c.phase === "prepared" &&
                !c.publication &&
                c.blocks.every((p) => p.attemptedBytes === 0))
            )
          )
            fail("LOCAL_DISCARD_UNSAFE");
          if (!c.localPayloadRemoved) {
            checkpoints.put(
              envelope({
                ...c,
                revision: c.revision + 1,
                localPayloadRemoved: true,
              }),
              c.id,
            );
            for (const p of c.blocks)
              tx.objectStore("blocks").delete([c.id, p.block.index]);
          }
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(Error("LOCAL_CLEANUP_PENDING"));
      tx.onerror = () => {};
    });
  }
  async discardLocalBlocks(id: string) {
    return new Promise<void>((resolve, reject) => {
      const tx = this.transaction("readwrite");
      const r = tx.objectStore("checkpoints").get(id);
      r.onsuccess = () => {
        try {
          const c = openEnvelope(r.result);
          if (!(
            ["completed", "abandoned"].includes(c.phase) ||
            (c.phase === "cancelled" &&
              c.blocks.every((p) => p.attemptedBytes === 0))
          ))
            fail("LOCAL_DISCARD_UNSAFE");
          for (const p of c.blocks)
            tx.objectStore("blocks").delete([id, p.block.index]);
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(Error("LOCAL_DISCARD_UNSAFE"));
      tx.onerror = () => {};
    });
  }
}
