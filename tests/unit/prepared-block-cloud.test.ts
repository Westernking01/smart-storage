import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  PreparedBlockCloudBoundary,
  type PreparedBlockAuthority,
} from "../../src/lib/gateway/prepared-block.server";
import { SupabaseStorageProvider } from "../../src/lib/gateway/supabase-storage-provider.server";
import { encodeBlock, digest } from "../../src/lib/transfers/codec";
import { BLOCK_BYTES } from "../../src/lib/transfers/format";
import type { Checkpoint } from "../../src/lib/transfers/checkpoint";
import type {
  ProvisionalObservation,
  StorageTransport,
  WriteIntent,
} from "../../src/lib/gateway/provider-contracts";

const ownerId = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const original = new TextEncoder().encode(
    "prepared compressed upload block ".repeat(3000),
  );
  const encoded = await encodeBlock(original);
  const block = {
    index: 0,
    offset: 0,
    originalBytes: original.length,
    encodedBytes: encoded.bytes.length,
    codec: encoded.codec,
    originalSha256: digest(original),
    encodedSha256: digest(encoded.bytes),
  };
  const manifest = {
    format: "compression-spike" as const,
    version: 1 as const,
    blockSize: BLOCK_BYTES,
    originalBytes: original.length,
    originalSha256: digest(original),
    blocks: [block],
  };
  const checkpoint: Checkpoint = {
    version: 1,
    id: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    ownerId,
    originalBytes: original.length,
    sourceSha256: digest(original),
    blockSize: BLOCK_BYTES,
    phase: "prepared",
    manifest,
    blocks: [
      {
        block,
        phase: "prepared",
        attemptedBytes: 0,
        acknowledgedBytes: 0,
        attemptId: null,
      },
    ],
  };
  const intent = {
    ownerId,
    sessionId: "session",
    fileId: "file",
    attemptId: "attempt",
    requestId: "request",
    resourceId: "resource",
    executorId: "executor",
    epoch: 1,
    dispatchGeneration: 1,
    bucket: "private",
    path: "server/immutable/block",
    declaredBytes: block.encodedBytes,
    expectedSha256: block.encodedSha256,
    operation: "single-object-create",
  } satisfies WriteIntent;
  const reservation = {
    ownerId,
    sessionId: "session",
    state: "reserved" as const,
    expiresAt: 200,
    reservedBytes: String(block.encodedBytes + 50),
    requiredExposureBytes: String(block.encodedBytes + 50),
  };
  const resolve = vi.fn<PreparedBlockAuthority["resolve"]>(async (scope) => ({
    scope,
    intent,
    reservation,
  }));
  const records: ProvisionalObservation[] = [];
  let consumed = false;
  const consumeDispatch = vi.fn(async (value: WriteIntent) => {
    if (consumed) return null;
    consumed = true;
    return {
      intent: value,
      decisionId: "decision",
      writerId: "writer",
      reservationId: "reservation",
      exposureId: "exposure",
      maximumEncodedBytes: block.encodedBytes,
      reservedExposureBytes: block.encodedBytes + 50,
      allowZeroBytes: false,
    };
  });
  const create = vi.fn<StorageTransport["create"]>(
    async ({ body, options, intent: sent }) => {
      expect(options).toMatchObject({
        upsert: false,
        retries: 0,
        redirect: "error",
      });
      expect(sent.path).toBe("server/immutable/block");
      let length = 0;
      for await (const bytes of body) length += bytes.length;
      expect(length).toBe(block.encodedBytes);
      return {
        kind: "response",
        status: 200,
        provenance: "authenticated-storage-response",
        acknowledgedBytes: length,
        requestId: null,
        version: null,
        etag: null,
      };
    },
  );
  const append = vi.fn(async (record: ProvisionalObservation) => {
    records.push(record);
    return { receiptId: `receipt-${records.length}` };
  });
  const provider = new SupabaseStorageProvider(
    { assertSupported: () => {}, create },
    { consumeDispatch },
    { append },
  );
  const write = vi.spyOn(provider, "write");
  const authenticate = vi.fn(async () => ({ ownerId }));
  const boundary = () =>
    new PreparedBlockCloudBoundary(
      { authenticate },
      { resolve },
      provider,
      () => 100,
    );
  const input = {
    authorization: "verified-by-injected-authenticator",
    checkpoint,
    blockIndex: 0,
    staged: new Blob([encoded.bytes]),
  };
  return {
    boundary,
    input,
    checkpoint,
    block,
    reservation,
    intent,
    resolve,
    authenticate,
    create,
    write,
    records,
    append,
    consumeDispatch,
  };
}

describe("offline prepared-block Supabase composition", () => {
  it("dispatches the existing gzip/hash/manifest workflow with guarded create-only options", async () => {
    const f = await fixture();
    expect(f.block.codec).toBe("gzip");
    const result = await f.boundary().dispatch(f.input);
    expect(result.state).toBe("pending-reconciliation");
    expect(result.observation).toMatchObject({
      state: "response-observed",
      certified: false,
      retainHolds: true,
      sha256: f.block.encodedSha256,
      digestComplete: true,
    });
    expect(f.records.map((r) => r.state)).toEqual([
      "dispatch-intent",
      "response-observed",
    ]);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("rejects missing authorization before authentication or provider calls", async () => {
    const f = await fixture();
    await expect(
      f.boundary().dispatch({ ...f.input, authorization: undefined }),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it("rejects failed verified authentication", async () => {
    const f = await fixture();
    f.authenticate.mockResolvedValue({ ownerId: "" });
    await expect(f.boundary().dispatch(f.input)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["checkpoint", "intent", "reservation"])(
    "rejects wrong %s owner before dispatch",
    async (target) => {
      const f = await fixture();
      f[target as "checkpoint" | "intent" | "reservation"].ownerId =
        "33333333-3333-4333-8333-333333333333";
      await expect(f.boundary().dispatch(f.input)).rejects.toThrow();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    "missing",
    "expired",
    "quota",
    "unknown-exposure",
    "scope",
    "descriptor",
  ])("blocks %s authority before provider calls", async (mode) => {
    const f = await fixture();
    if (mode === "missing") f.resolve.mockResolvedValue(null);
    if (mode === "expired") f.reservation.expiresAt = 100;
    if (mode === "quota") f.reservation.reservedBytes = "0";
    if (mode === "unknown-exposure")
      f.reservation.requiredExposureBytes = "unknown";
    if (mode === "scope")
      f.resolve.mockImplementation(async (scope) => ({
        scope: { ...scope, blockIndex: 1 },
        intent: f.intent,
        reservation: f.reservation,
      }));
    if (mode === "descriptor") f.intent.expectedSha256 = "0".repeat(64);
    await expect(f.boundary().dispatch(f.input)).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each(["manifest", "bytes", "pending"])(
    "rejects invalid %s before authority consumption",
    async (mode) => {
      const f = await fixture();
      if (mode === "manifest") f.checkpoint.manifest!.blocks[0].index = 4;
      if (mode === "bytes")
        f.input.staged = new Blob([new Uint8Array(f.block.encodedBytes)]);
      if (mode === "pending") f.checkpoint.phase = "ambiguous";
      await expect(f.boundary().dispatch(f.input)).rejects.toThrow();
      expect(f.consumeDispatch).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it.each(["lost-response", "conflict", "unknown-length", "evidence-ack"])(
    "retains %s and cannot resend through a reconstructed boundary",
    async (mode) => {
      const f = await fixture();
      if (mode === "lost-response")
        f.create.mockImplementation(async ({ body }) => {
          for await (const bytes of body) void bytes;
          throw Error("response lost after write");
        });
      if (mode === "conflict" || mode === "unknown-length") {
        const original = f.create.getMockImplementation()!;
        f.create.mockImplementation(async (input) => ({
          ...(await original(input)),
          status: mode === "conflict" ? 409 : 200,
          acknowledgedBytes: null,
        }));
      }
      if (mode === "evidence-ack")
        f.append.mockImplementation(async (record) => {
          f.records.push(record);
          if (record.state !== "dispatch-intent")
            throw Error("lost persistence acknowledgment");
          return { receiptId: "initial" };
        });
      const result = await f.boundary().dispatch(f.input);
      expect(result.observation).toMatchObject({
        retainHolds: true,
        certified: false,
      });
      expect(result.state).toBe("pending-reconciliation");
      if (mode !== "evidence-ack")
        expect(result.observation.state).toBe("ambiguous");
      else expect(result.evidencePersistence).toBe("failed-or-unknown");
      await expect(f.boundary().dispatch(f.input)).rejects.toThrow(
        "INVALID_GRANT",
      );
      expect(f.create).toHaveBeenCalledTimes(1);
    },
  );
});
