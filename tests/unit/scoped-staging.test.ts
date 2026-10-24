import { describe, it, expect } from "vitest";
import { ScopedStaging, stagingDatabase } from "@/lib/transfers/scoped-store";
import { prepare } from "@/lib/transfers/prepare";
import { restore } from "@/lib/transfers/restore";
import {
  envelope,
  openEnvelope,
  validateTransition,
  type Checkpoint,
} from "@/lib/transfers/checkpoint";
import type { StagingStore } from "@/lib/transfers/store";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
class Memory implements StagingStore {
  rows = new Map<string, ReturnType<typeof envelope>>();
  blocks = new Map<string, Blob>();
  async load(id: string) {
    return openEnvelope(this.rows.get(id));
  }
  async save(
    c: Checkpoint,
    revision: number | null,
    staged?: { index: number; blob: Blob },
  ) {
    if (revision !== null) validateTransition(await this.load(c.id), c);
    this.rows.set(c.id, envelope(c));
    if (staged) this.blocks.set(`${c.id}/${staged.index}`, staged.blob);
  }
  async block(id: string, index: number) {
    return this.blocks.get(`${id}/${index}`)!;
  }
}
describe("account scoped local staging", () => {
  it("partitions namespaces without assigning anonymous checkpoints to an account", async () => {
    expect(stagingDatabase({ kind: "anonymous" })).toBe(
      "smart-storage-local-staging-v1",
    );
    expect(stagingDatabase({ kind: "account", ownerId: A })).not.toBe(
      stagingDatabase({ kind: "account", ownerId: B }),
    );
    const memory = new Memory();
    const anon = new ScopedStaging(memory, { kind: "anonymous" }, () => A);
    const c = await prepare(new Blob(["anonymous"]), anon);
    const old = memory.rows.get(c.id);
    expect(c.ownerId).toBeUndefined();
    const account = new ScopedStaging(
      memory,
      { kind: "account", ownerId: A },
      () => A,
    );
    await expect(account.load(c.id)).rejects.toThrow("STAGING_OWNER_MISMATCH");
    expect(memory.rows.get(c.id)).toEqual(old);
  });
  it("binds new stages, blocks another account and preserves exact restoration", async () => {
    const memory = new Memory();
    let owner: string | null = A;
    const own = new ScopedStaging(
      memory,
      { kind: "account", ownerId: A },
      () => owner,
    );
    const c = await prepare(new Blob(["exact account bytes"]), own);
    expect(c.ownerId).toBe(A);
    const other = new ScopedStaging(
      memory,
      { kind: "account", ownerId: B },
      () => B,
    );
    await expect(other.load(c.id)).rejects.toThrow("STAGING_OWNER_MISMATCH");
    await expect(other.block(c.id, 0)).rejects.toThrow();
    let written = 0;
    expect(
      (
        await restore(
          c.manifest,
          {
            open: async (b) => ({
              index: b.index,
              stream: (await own.block(c.id, b.index)).stream(),
            }),
          },
          {
            write: async (b) => {
              written += b.length;
            },
            commit: async () => {},
            abort: async () => {},
          },
        )
      ).verified,
    ).toBe(true);
    expect(written).toBe(c.originalBytes);
    owner = B;
    await expect(own.load(c.id)).rejects.toThrow("STAGING_ACCOUNT_CHANGED");
    owner = null;
    await expect(own.block(c.id, 0)).rejects.toThrow("STAGING_ACCOUNT_CHANGED");
  });
  it("rejects ownership reassignment without changing history", async () => {
    const memory = new Memory();
    const own = new ScopedStaging(
      memory,
      { kind: "account", ownerId: A },
      () => A,
    );
    const c = await prepare(new Blob(["bound"]), own);
    const old = memory.rows.get(c.id);
    await expect(
      own.save({ ...c, ownerId: B, revision: c.revision + 1 }, c.revision),
    ).rejects.toThrow();
    expect(memory.rows.get(c.id)).toEqual(old);
  });
});
