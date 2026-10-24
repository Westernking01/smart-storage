import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { LocalDiskTransport } from "./local-disk-transport.server";
import type { WriteIntent, DispatchPermit } from "./provider-contracts";
import { parseManifest } from "../transfers/format";
import { parseFileMetadata } from "../domain/file-metadata";

export interface VolumeDatabase {
  command(
    owner: string,
    action: string,
    id: string | null,
    data?: Record<string, unknown>,
  ): Promise<unknown>;
}
const objectSchema = z
  .object({
    id: z.uuid(),
    index: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().max(8388608),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["pending", "writing", "complete", "removed"]),
    executorId: z.uuid().nullable(),
    receiptId: z.uuid().nullable(),
  })
  .strict();
const statusSchema = z
  .object({
    id: z.uuid(),
    fileId: z.uuid(),
    state: z.string(),
    heldBytes: z.string().regex(/^\d+$/),
    volumeId: z.uuid(),
    manifest: z.unknown(),
    objects: objectSchema.array().min(1).max(128),
  })
  .strict();
export type VolumeStatus = z.infer<typeof statusSchema>;

/** Opt-in local data plane. The caller supplies ONLY a freshly verified owner.
 * Receipts attest this supervisor's terminated local writes, not host durability
 * or remote-provider semantics. Unknown restart writers retain liability. */
export class VolumeLifecycle {
  private readonly executor = randomUUID();
  constructor(
    private db: VolumeDatabase,
    private disk: LocalDiskTransport,
    private volumeId: string,
  ) {
    z.uuid().parse(volumeId);
  }
  async status(owner: string, id: string, action = "status") {
    z.uuid().parse(owner);
    z.uuid().parse(id);
    const s = statusSchema.parse(await this.db.command(owner, action, id));
    if (s.volumeId !== this.volumeId) throw Error("VOLUME_MISMATCH");
    parseManifest(s.manifest);
    return s;
  }
  async begin(owner: string, input: unknown) {
    z.uuid().parse(owner);
    const v = z
      .object({
        key: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
        metadata: z.unknown(),
        manifest: z.unknown(),
      })
      .strict()
      .parse(input);
    const metadata = parseFileMetadata(v.metadata),
      manifest = parseManifest(v.manifest);
    if (manifest.blocks.some((b) => b.encodedBytes > b.originalBytes))
      throw Error("INVALID_MANIFEST");
    return statusSchema.parse(
      await this.db.command(owner, "begin", null, {
        key: v.key,
        name: metadata.originalName,
        mime: metadata.originalMime,
        manifest,
        manifestText: JSON.stringify(manifest),
        volumeId: this.volumeId,
      }),
    );
  }
  private intent(
    owner: string,
    s: VolumeStatus,
    o: VolumeStatus["objects"][number],
  ): WriteIntent {
    if (!o.executorId) throw Error("UNDISPATCHED_OBJECT");
    return {
      ownerId: owner,
      sessionId: s.id,
      fileId: s.fileId,
      attemptId: o.id,
      requestId: o.id,
      resourceId: o.id,
      executorId: o.executorId,
      epoch: 1,
      dispatchGeneration: 1,
      bucket: "volume",
      path: `${s.volumeId}/${o.id}`,
      declaredBytes: o.bytes,
      expectedSha256: o.sha256,
      operation: "single-object-create",
    };
  }
  async upload(
    owner: string,
    id: string,
    index: number,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ) {
    await this.status(owner, id);
    const s = statusSchema.parse(
      await this.db.command(owner, "claim", id, {
        index,
        executorId: this.executor,
        volumeId: this.volumeId,
      }),
    );
    const o = s.objects.find((o) => o.index === index)!;
    const intent = this.intent(owner, s, o);
    const permit: DispatchPermit = {
      intent,
      decisionId: o.id,
      writerId: this.executor,
      reservationId: id,
      exposureId: o.id,
      maximumEncodedBytes: o.bytes,
      reservedExposureBytes: o.bytes,
      allowZeroBytes: o.bytes === 0,
    };
    // Transport returns only after actual worker termination (including finally).
    // Failure/lost SQL acknowledgment leaves the durable one-use claim occupied.
    await this.disk.create({
      intent,
      permit,
      body: source,
      signal,
      options: {
        redirect: "error",
        retries: 0,
        upsert: false,
        contentType: "application/octet-stream",
        contentLength: o.bytes,
      },
    });
    return this.db.command(owner, "receipt", id, {
      objectId: o.id,
      executorId: this.executor,
      bytes: o.bytes,
      sha256: o.sha256,
      volumeId: this.volumeId,
    });
  }
  async publish(owner: string, id: string) {
    await this.status(owner, id);
    return this.db.command(owner, "publish", id);
  }
  async cancel(owner: string, id: string) {
    return this.cleanup(owner, id, "cancel");
  }
  async delete(owner: string, id: string) {
    return this.cleanup(owner, id, "delete");
  }
  private async cleanup(
    owner: string,
    id: string,
    action: "cancel" | "delete",
  ) {
    await this.status(owner, id);
    const s = statusSchema.parse(await this.db.command(owner, action, id));
    if (s.state === "settled") return s;
    await this.db.command(owner, "cleanup-ready", id);
    for (const o of s.objects) {
      if (o.state === "removed") continue;
      if (o.state !== "pending") {
        // Same supervisor only. Restart ambiguity is deliberately not released.
        await this.disk.terminateAndRemove(this.intent(owner, s, o));
      }
      await this.db.command(owner, "removed", id, {
        objectId: o.id,
        executorId: o.executorId,
        volumeId: this.volumeId,
      });
    }
    return this.db.command(
      owner,
      action === "delete" ? "settle-delete" : "settle",
      id,
    );
  }
  async download(owner: string, id: string, index: number) {
    const s = await this.status(owner, id, "read");
    const o = s.objects.find((o) => o.index === index);
    if (!o || o.state !== "complete") throw Error("NOT_FOUND");
    const intent = this.intent(owner, s, o),
      disk = this.disk,
      db = this.db;
    return {
      bytes: o.bytes,
      source: (async function* () {
        const readerId = randomUUID();
        // Account locking serializes acquisition with deletion. An unknown/lost
        // close acknowledgment retains the reader liability; never expire it.
        await db.command(owner, "read-open", id, { objectId: o.id, readerId });
        try {
          yield* disk.read(intent);
        } finally {
          await db.command(owner, "read-close", id, { readerId });
        }
      })(),
    };
  }
  async list(owner: string) {
    return this.db.command(z.uuid().parse(owner), "list", null);
  }
  async account(owner: string) {
    return this.db.command(z.uuid().parse(owner), "account", null);
  }
}
