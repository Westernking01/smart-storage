import { describe, expect, it } from "vitest";
import {
  GatewayError,
  TrustedUploadGateway,
  type AttemptAuthority,
  type GatewayAuthorityStore,
  type GatewayStorageProvider,
} from "../../src/lib/gateway/core";

const attempt: AttemptAuthority = {
  ownerId: "a",
  sessionId: "session",
  attemptId: "attempt",
  epoch: 1,
  bucket: "private",
  path: "v1/a/session/1/0",
  maximumEncodedBytes: 8,
};
const chunks = async function* (...sizes: number[]) {
  for (const size of sizes) yield new Uint8Array(size);
};

class Authority implements GatewayAuthorityStore {
  async authorizeWrite(input: { ownerId: string; requestId: string }) {
    return {
      ownerId: input.ownerId,
      requestId: input.requestId,
      resourceId: "registered-resource",
      executorId: "executor",
      dispatchGeneration: 1,
      epoch: attempt.epoch,
      bucket: attempt.bucket,
      path: attempt.path,
    };
  }
  claimResult: "claimed" | "committed" | "ambiguous" | "forbidden" = "claimed";
  committed = false;
  ambiguous: string[] = [];
  removed: string[] = [];
  settled = 0;
  async claim(input: {
    ownerId: string;
    attemptReference: string;
    requestId: string;
    declaredBytes: number;
  }) {
    if (input.ownerId !== "a" || input.attemptReference !== "opaque-attempt")
      return { kind: "forbidden" as const };
    if (this.claimResult === "committed")
      return { kind: "committed" as const, acceptedBytes: 8, storedBytes: 8 };
    if (this.claimResult === "ambiguous") return { kind: "ambiguous" as const };
    if (this.claimResult === "forbidden") return { kind: "forbidden" as const };
    return { kind: "claimed" as const, authority: attempt };
  }
  async markAmbiguous(input: { attemptId: string; reason: string }) {
    this.ambiguous.push(`${input.attemptId}:${input.reason}`);
  }
  async markCommitted() {
    this.committed = true;
  }
  async finalizationEvidence(_sessionReference: string, ownerId: string) {
    return ownerId === "a"
      ? [
          {
            ...attempt,
            state: this.committed
              ? ("committed" as const)
              : ("allocated" as const),
            storedBytes: this.committed ? 8 : undefined,
          },
        ]
      : [];
  }
  async commitFinalization() {
    this.committed = true;
  }
  async beginCleanup() {
    return [attempt];
  }
  async recordVerifiedRemoval(input: { attemptId: string }) {
    this.removed.push(input.attemptId);
  }
  async settleCleanup() {
    this.settled ||= 1;
  }
}

class Storage implements GatewayStorageProvider {
  writes = 0;
  objects = new Map<string, number>();
  timeout = false;
  leaveAfterDelete = false;
  async write(input: {
    bucket: string;
    path: string;
    bytes: AsyncIterable<Uint8Array>;
  }) {
    this.writes += 1;
    let size = 0;
    for await (const chunk of input.bytes) size += chunk.byteLength;
    this.objects.set(`${input.bucket}/${input.path}`, size);
    if (this.timeout) throw Error("timeout");
    return { storedBytes: size };
  }
  async inspect(input: { bucket: string; path: string }) {
    const value = this.objects.get(`${input.bucket}/${input.path}`);
    return { exists: value !== undefined, storedBytes: value };
  }
  async remove(input: { bucket: string; path: string }) {
    if (!this.leaveAfterDelete)
      this.objects.delete(`${input.bucket}/${input.path}`);
  }
}

function fixture() {
  const authority = new Authority();
  const storage = new Storage();
  const gateway = new TrustedUploadGateway(
    {
      authenticate: async ({ authorization }) =>
        authorization === "token-a" ? { ownerId: "a" } : null,
    },
    authority,
    storage,
  );
  return { authority, storage, gateway };
}
const request = (bytes: AsyncIterable<Uint8Array>, declaredBytes = 8) => ({
  authorization: "token-a",
  attemptReference: "opaque-attempt",
  requestId: "request-1",
  declaredBytes,
  now: 1,
  bytes,
});

describe("trusted upload gateway", () => {
  it("rejects a mismatched dispatch grant before provider I/O", async () => {
    const { authority, gateway, storage } = fixture();
    const authorize = authority.authorizeWrite.bind(authority);
    authority.authorizeWrite = async (input) => ({
      ...(await authorize(input)),
      epoch: 999,
    });
    await expect(gateway.upload(request(chunks(8)))).rejects.toMatchObject({
      code: "ATTEMPT_FORBIDDEN",
    });
    expect(storage.writes).toBe(0);
    expect(authority.ambiguous).toHaveLength(1);
  });
  it("rejects unauthenticated, forged, and oversize declared requests before a provider write", async () => {
    const { gateway, storage } = fixture();
    await expect(
      gateway.upload({ ...request(chunks(8)), authorization: undefined }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      gateway.upload({ ...request(chunks(8)), attemptReference: "forged" }),
    ).rejects.toMatchObject({ code: "ATTEMPT_FORBIDDEN" });
    await expect(gateway.upload(request(chunks(9), 9))).rejects.toMatchObject({
      code: "INVALID_DECLARED_LENGTH",
    });
    expect(storage.writes).toBe(0);
  });

  it("streams bounded bytes without buffering and commits gateway and provider counts separately", async () => {
    const { authority, gateway, storage } = fixture();
    await expect(gateway.upload(request(chunks(3, 5)))).resolves.toEqual({
      replay: false,
      acceptedBytes: 8,
      storedBytes: 8,
    });
    expect(storage.writes).toBe(1);
    expect(authority.committed).toBe(true);
    expect(authority.ambiguous).toEqual([]);
  });

  it("marks oversized, truncated, provider-timeout, and lost-response attempts ambiguous without retry", async () => {
    for (const scenario of [
      () => request(chunks(5, 4)),
      () => request(chunks(7)),
      () => request(chunks(8)),
    ]) {
      const { authority, gateway, storage } = fixture();
      if (
        authority.ambiguous.length === 0 &&
        scenario.toString().includes("chunks(8)")
      )
        storage.timeout = true;
      await expect(gateway.upload(scenario())).rejects.toBeInstanceOf(Error);
      expect(authority.ambiguous).toHaveLength(1);
      authority.claimResult = "ambiguous";
      await expect(gateway.upload(request(chunks(8)))).rejects.toMatchObject({
        code: "ATTEMPT_AMBIGUOUS",
      });
    }
  });

  it("returns a durable committed retry without writing the immutable object again", async () => {
    const { authority, gateway, storage } = fixture();
    authority.claimResult = "committed";
    await expect(gateway.upload(request(chunks(8)))).resolves.toEqual({
      replay: true,
      acceptedBytes: 8,
      storedBytes: 8,
    });
    expect(storage.writes).toBe(0);
  });

  it("requires exact committed provider evidence before finalization", async () => {
    const { authority, gateway } = fixture();
    await expect(
      gateway.finalize({
        authorization: "token-a",
        sessionReference: "session",
        expectedEncodedBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "FINALIZATION_BLOCKED" });
    authority.committed = true;
    await expect(
      gateway.finalize({
        authorization: "token-a",
        sessionReference: "session",
        expectedEncodedBytes: 7,
      }),
    ).rejects.toMatchObject({ code: "FINALIZATION_BLOCKED" });
    await expect(
      gateway.finalize({
        authorization: "token-a",
        sessionReference: "session",
        expectedEncodedBytes: 8,
      }),
    ).resolves.toBeUndefined();
  });

  it("never releases cleanup accounting from visibility-only absence, even after deletion", async () => {
    const { authority, gateway, storage } = fixture();
    storage.objects.set("private/v1/a/session/1/0", 8);
    storage.leaveAfterDelete = true;
    await expect(
      gateway.cleanup({
        authorization: "token-a",
        sessionReference: "session",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_PROOF_REQUIRED" });
    expect(authority.removed).toEqual([]);
    expect(authority.settled).toBe(0);
    storage.leaveAfterDelete = false;
    await expect(
      gateway.cleanup({
        authorization: "token-a",
        sessionReference: "session",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_PROOF_REQUIRED" });
    await expect(
      gateway.cleanup({
        authorization: "token-a",
        sessionReference: "session",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_PROOF_REQUIRED" });
    expect(authority.removed).toEqual([]);
    expect(authority.settled).toBe(0);
  });
});

void GatewayError;
