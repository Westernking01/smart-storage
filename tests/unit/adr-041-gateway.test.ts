import { describe, expect, it } from "vitest";
import {
  GatewayLedger,
  GatewayPolicyError,
  type Forwarder,
} from "../../experiments/adr-041-gateway/gateway-ledger";

const owner = "owner-a";
const other = "owner-b";
const at = 1_000;
const oneChunk = async function* (size: number) {
  yield new Uint8Array(size);
};

function fixture() {
  const ledger = new GatewayLedger();
  ledger.registerAccount(owner, 100);
  ledger.registerAccount(other, 100);
  ledger.reserve({
    ownerId: owner,
    sessionId: "s1",
    heldBytes: 64,
    maxConcurrent: 1,
    expiresAt: at + 100,
  });
  ledger.allocate({
    ownerId: owner,
    sessionId: "s1",
    attemptId: "a1",
    path: "v1/a/s1/1/0",
    epoch: 1,
    maxBytes: 32,
  });
  return ledger;
}

const collectingForwarder =
  (calls: { count: number }): Forwarder =>
  async ({ chunks }) => {
    calls.count += 1;
    let observedBytes = 0;
    for await (const chunk of chunks) observedBytes += chunk.byteLength;
    return { observedBytes };
  };

describe("ADR-041 trusted gateway local proof", () => {
  it("rejects a declared pre-budget overflow before forwarding provider bytes", async () => {
    const ledger = fixture();
    const calls = { count: 0 };
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/0",
        epoch: 1,
        requestId: "r1",
        declaredBytes: 33,
        now: at,
        chunks: oneChunk(33),
        forward: collectingForwarder(calls),
      }),
    ).rejects.toMatchObject({ code: "BODY_LIMIT_EXCEEDED" });
    expect(calls.count).toBe(0);
    expect(ledger.attemptState("s1", "a1")).toBe("allocated");
  });

  it("enforces owner, immutable path, epoch, expiry, and a single in-flight stream", async () => {
    const ledger = fixture();
    const release: { resolve?: () => void } = {};
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/forged",
        epoch: 1,
        requestId: "forged-path",
        declaredBytes: 10,
        now: at,
        chunks: oneChunk(10),
        forward: collectingForwarder({ count: 0 }),
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_SCOPE_MISMATCH" });
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/0",
        epoch: 2,
        requestId: "forged-epoch",
        declaredBytes: 10,
        now: at,
        chunks: oneChunk(10),
        forward: collectingForwarder({ count: 0 }),
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_SCOPE_MISMATCH" });
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/0",
        epoch: 1,
        requestId: "expired",
        declaredBytes: 10,
        now: at + 100,
        chunks: oneChunk(10),
        forward: collectingForwarder({ count: 0 }),
      }),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED_OR_BLOCKED" });
    ledger.allocate({
      ownerId: owner,
      sessionId: "s1",
      attemptId: "a2",
      path: "v1/a/s1/1/1",
      epoch: 1,
      maxBytes: 10,
    });
    const slow: Forwarder = async ({ chunks }) => {
      for await (const chunk of chunks) {
        if (chunk.byteLength !== 10)
          throw new Error("unexpected fixture chunk");
        await new Promise<void>((resolve) => {
          release.resolve = resolve;
        });
      }
      return { observedBytes: 10 };
    };
    const running = ledger.upload({
      ownerId: owner,
      sessionId: "s1",
      attemptId: "a1",
      path: "v1/a/s1/1/0",
      epoch: 1,
      requestId: "r1",
      declaredBytes: 10,
      now: at,
      chunks: oneChunk(10),
      forward: slow,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a2",
        path: "v1/a/s1/1/1",
        epoch: 1,
        requestId: "r2",
        declaredBytes: 10,
        now: at,
        chunks: oneChunk(10),
        forward: collectingForwarder({ count: 0 }),
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_LIMIT_EXCEEDED" });
    release.resolve?.();
    await expect(running).resolves.toMatchObject({ observedBytes: 10 });
    await expect(
      ledger.upload({
        ownerId: other,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/0",
        epoch: 1,
        requestId: "r1",
        declaredBytes: 10,
        now: at,
        chunks: oneChunk(10),
        forward: collectingForwarder({ count: 0 }),
      }),
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("permits a committed retry only for its durable request identity and settles exactly once", async () => {
    const ledger = fixture();
    const calls = { count: 0 };
    const forward = collectingForwarder(calls);
    await ledger.upload({
      ownerId: owner,
      sessionId: "s1",
      attemptId: "a1",
      path: "v1/a/s1/1/0",
      epoch: 1,
      requestId: "r1",
      declaredBytes: 32,
      now: at,
      chunks: oneChunk(32),
      forward,
    });
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/0",
        epoch: 1,
        requestId: "r1",
        declaredBytes: 32,
        now: at,
        chunks: oneChunk(32),
        forward,
      }),
    ).resolves.toMatchObject({ idempotent: true });
    expect(calls.count).toBe(1);
    ledger.finalize(owner, "s1");
    expect(ledger.usage(owner)).toEqual({
      quotaBytes: 100,
      reservedBytes: 0,
      storedBytes: 32,
      slots: 0,
    });
    ledger.settleAfterVerifiedRemoval(owner, "s1", true);
    ledger.settleAfterVerifiedRemoval(owner, "s1", true);
    expect(ledger.usage(owner)).toEqual({
      quotaBytes: 100,
      reservedBytes: 0,
      storedBytes: 0,
      slots: 0,
    });
  });

  it("fails closed after a partial or ambiguous provider outcome and retains the reservation", async () => {
    const ledger = fixture();
    const interrupted: Forwarder = async ({ chunks }) => {
      for await (const chunk of chunks) {
        if (chunk.byteLength > 0) throw new Error("network lost");
      }
      return { observedBytes: 0 };
    };
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/0",
        epoch: 1,
        requestId: "r1",
        declaredBytes: 10,
        now: at,
        chunks: oneChunk(10),
        forward: interrupted,
      }),
    ).rejects.toThrow("network lost");
    expect(ledger.attemptState("s1", "a1")).toBe("ambiguous");
    expect(ledger.usage(owner)).toEqual({
      quotaBytes: 100,
      reservedBytes: 64,
      storedBytes: 0,
      slots: 1,
    });
    await expect(
      ledger.upload({
        ownerId: owner,
        sessionId: "s1",
        attemptId: "a1",
        path: "v1/a/s1/1/0",
        epoch: 1,
        requestId: "r1",
        declaredBytes: 10,
        now: at,
        chunks: oneChunk(10),
        forward: interrupted,
      }),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED_OR_BLOCKED" });
    expect(() => ledger.settleAfterVerifiedRemoval(owner, "s1", false)).toThrow(
      GatewayPolicyError,
    );
  });
});
