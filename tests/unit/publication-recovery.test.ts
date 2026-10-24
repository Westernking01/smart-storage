import { expect, it, vi } from "vitest";
import { prepare } from "@/lib/transfers/prepare";
import { recovery, validateTransition } from "@/lib/transfers/checkpoint";
import {
  upload,
  stopLocal,
  reconcileOffset,
  type UploadTransport,
} from "@/lib/transfers/upload";
import { MemoryStore } from "../fixtures/memory-staging";

async function fixture() {
  const store = new MemoryStore();
  const checkpoint = await prepare(
    new Blob(["offline receipt fixture"]),
    store,
  );
  const transport: UploadTransport = {
    write: vi.fn(async (r) => ({ offset: r.offset + r.body.length })),
    verify: async (_id, index) => checkpoint.blocks[index].block,
    publish: vi.fn(async (_id, manifestSha256) => ({
      published: true as const,
      manifestSha256,
      originalSha256: checkpoint.sourceSha256,
    })),
  };
  return { store, checkpoint, transport };
}

it("cancellation before upload dispatch leaves no attempted bytes or publication", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    upload(f.checkpoint.id, f.store, f.transport, controller.signal),
  ).rejects.toThrow();
  expect(f.transport.write).not.toHaveBeenCalled();
  expect(f.transport.publish).not.toHaveBeenCalled();
  expect((await f.store.load(f.checkpoint.id)).blocks[0].attemptedBytes).toBe(
    0,
  );
  expect((await stopLocal(f.checkpoint.id, f.store)).phase).toBe("cancelled");
});

it("failure to persist uncertainty retains the dispatch fence and denies local cleanup", async () => {
  const f = await fixture();
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => {
    if (args[0].phase === "ambiguous") throw Error("LOCAL_CLEANUP_FAILED");
    await save(...args);
  };
  f.transport.publish = vi.fn(async () => {
    throw Error("ACK_LOST");
  });
  await expect(upload(f.checkpoint.id, f.store, f.transport)).rejects.toThrow(
    "LOCAL_CLEANUP_FAILED",
  );
  const durable = await f.store.load(f.checkpoint.id);
  expect(durable.publication).toBe("dispatched");
  expect(recovery(durable).requiresRemoteReconciliation).toBe(true);
  await expect(stopLocal(durable.id, f.store, true)).rejects.toThrow(
    "CANCELLATION_REQUIRES_RECONCILIATION",
  );
  await expect(upload(durable.id, f.store, f.transport)).rejects.toThrow(
    "UPLOAD_RECOVERY_REQUIRED",
  );
  await expect(
    reconcileOffset(
      durable.id,
      0,
      durable.blocks[0].block.encodedBytes,
      f.store,
    ),
  ).rejects.toThrow("RECONCILIATION_INVALID");
  expect(f.transport.publish).toHaveBeenCalledTimes(1);
  const forged = structuredClone(durable);
  forged.revision++;
  delete forged.publication;
  expect(() => validateTransition(durable, forged)).toThrow(
    "CHECKPOINT_TRANSITION_INVALID",
  );
});

it("a response received after cancellation preserves unknown publication status", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const publish = f.transport.publish;
  f.transport.publish = async (...args) => {
    const receipt = await publish(...args);
    controller.abort();
    return receipt;
  };
  await expect(
    upload(f.checkpoint.id, f.store, f.transport, controller.signal),
  ).rejects.toThrow();
  const durable = await f.store.load(f.checkpoint.id);
  expect(durable.phase).toBe("ambiguous");
  expect(durable.publication).toBe("dispatched");
});
