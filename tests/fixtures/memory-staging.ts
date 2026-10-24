import {
  envelope,
  openEnvelope,
  validateTransition,
  type Checkpoint,
} from "../../src/lib/transfers/checkpoint";
import type { StagingStore } from "../../src/lib/transfers/store";

/** Existing transfer-suite fixture, shared with the development cloud integration. */
export class MemoryStore implements StagingStore {
  records = new Map<string, ReturnType<typeof envelope>>();
  blobs = new Map<string, Blob>();
  quota = Infinity;
  async load(id: string) {
    return openEnvelope(this.records.get(id));
  }
  async save(
    c: Checkpoint,
    expected: number | null,
    staged?: { index: number; blob: Blob },
  ) {
    if (
      expected === null
        ? this.records.has(c.id)
        : openEnvelope(this.records.get(c.id)).revision !== expected
    )
      throw Error("CHECKPOINT_CONFLICT");
    if (staged && staged.blob.size > this.quota)
      throw Error("STAGING_QUOTA_EXCEEDED");
    if (expected !== null)
      validateTransition(openEnvelope(this.records.get(c.id)), c);
    this.records.set(c.id, envelope(c));
    if (staged) this.blobs.set(`${c.id}/${staged.index}`, staged.blob);
  }
  async block(id: string, index: number) {
    const blob = this.blobs.get(`${id}/${index}`);
    if (!blob) throw Error("STAGED_DATA_MISSING");
    return blob;
  }
}
