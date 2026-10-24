import { IndexedStaging, type StagingStore } from "./store";
import type { Checkpoint } from "./checkpoint";
export type StagingScope =
  { kind: "anonymous" } | { kind: "account"; ownerId: string };
export function stagingDatabase(scope: StagingScope) {
  if (scope.kind === "anonymous") return "smart-storage-local-staging-v1";
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      scope.ownerId,
    )
  )
    throw Error("STAGING_OWNER_INVALID");
  return `smart-storage-account-staging-v1-${scope.ownerId.toLowerCase()}`;
}
/** App-level partition/access barrier, not encryption against same-origin script. */
export class ScopedStaging implements StagingStore {
  constructor(
    private inner: StagingStore,
    private scope: StagingScope,
    private currentOwner: () => string | null,
  ) {
    stagingDatabase(scope);
    this.assert();
  }
  private assert() {
    if (
      this.scope.kind === "account" &&
      this.currentOwner() !== this.scope.ownerId
    )
      throw Error("STAGING_ACCOUNT_CHANGED");
  }
  private check(c: Checkpoint) {
    this.assert();
    if (
      c.ownerId !==
      (this.scope.kind === "account" ? this.scope.ownerId : undefined)
    )
      throw Error("STAGING_OWNER_MISMATCH");
  }
  async load(id: string) {
    this.assert();
    const c = await this.inner.load(id);
    this.check(c);
    return c;
  }
  async save(
    c: Checkpoint,
    revision: number | null,
    staged?: { index: number; blob: Blob },
  ) {
    this.assert();
    if (
      revision === null &&
      c.ownerId === undefined &&
      this.scope.kind === "account"
    )
      c.ownerId = this.scope.ownerId;
    this.check(c);
    await this.inner.save(c, revision, staged);
    this.assert();
  }
  async block(id: string, index: number) {
    await this.load(id);
    const blob = await this.inner.block(id, index);
    this.assert();
    return blob;
  }
  async list() {
    this.assert();
    if (!this.inner.list) throw Error("STAGING_LIST_UNSUPPORTED");
    const values = await this.inner.list();
    values.forEach((value) => this.check(value));
    this.assert();
    return values;
  }
  async rename(id: string, displayName: string) {
    await this.load(id);
    if (!this.inner.rename) throw Error("STAGING_RENAME_UNSUPPORTED");
    const value = await this.inner.rename(id, displayName);
    this.check(value);
    return value;
  }
  async delete(id: string) {
    await this.load(id);
    if (!this.inner.delete) throw Error("STAGING_DELETE_UNSUPPORTED");
    await this.inner.delete(id);
    this.assert();
  }
  async discardLocalBlocks(id: string) {
    await this.load(id);
    if (!(this.inner instanceof IndexedStaging))
      throw Error("STAGING_DISCARD_UNSUPPORTED");
    await this.inner.discardLocalBlocks(id);
    this.assert();
  }
  async releasePublishedPayload(receipt: Checkpoint) {
    this.check(receipt);
    await this.load(receipt.id);
    this.assert();
    if (!this.inner.releasePublishedPayload)
      throw Error("LOCAL_CLEANUP_PENDING");
    await this.inner.releasePublishedPayload(receipt);
    this.assert();
  }
  static async open(
    scope: StagingScope,
    currentOwner: () => string | null,
    namespace?: string,
  ) {
    if (
      namespace !== undefined &&
      (scope.kind !== "account" || !/^[a-z0-9_-]{1,100}$/.test(namespace))
    )
      throw Error("STAGING_NAMESPACE_INVALID");
    const inner = await IndexedStaging.open(
      stagingDatabase(scope) + (namespace ? `-${namespace}` : ""),
    );
    try {
      return {
        store: new ScopedStaging(inner, scope, currentOwner),
        close: () => inner.close(),
      };
    } catch (e) {
      inner.close();
      throw e;
    }
  }
}
