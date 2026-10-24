import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PostgresAuthority } from "../../src/lib/gateway/postgres-authority.server";
import { PostgresEvidence } from "../../src/lib/gateway/postgres-evidence.server";
import type {
  ProvisionalObservation,
  WriteIntent,
} from "../../src/lib/gateway/provider-contracts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const intent: WriteIntent = {
  ownerId: id(1),
  executorId: id(2),
  requestId: id(3),
  resourceId: id(4),
  sessionId: id(5),
  fileId: id(6),
  attemptId: id(7),
  epoch: 1,
  dispatchGeneration: 1,
  bucket: "private",
  path: "key",
  declaredBytes: 8,
  expectedSha256: "a".repeat(64),
  operation: "single-object-create",
};
const trusted = async () => ({
  ownerId: intent.ownerId,
  executorId: intent.executorId,
});
const permit = {
  intent,
  decisionId: intent.requestId,
  writerId: intent.executorId,
  reservationId: intent.sessionId,
  exposureId: intent.resourceId,
  maximumEncodedBytes: 8,
  reservedExposureBytes: 8,
  allowZeroBytes: false,
};
const observation: ProvisionalObservation = {
  ...permit,
  classification: "provisional",
  startedAt: 1,
  finishedAt: 1,
  state: "dispatch-intent",
  reason: "DISPATCH_INTENT",
  inputBytes: 0,
  forwardedBytes: 0,
  sha256: null,
  digestComplete: false,
  response: null,
  evidencePersistence: "pending-durable-ack",
  futureProviderEffectsPossible: true,
  retainHolds: true,
  certified: false,
};
function pool(
  options: { allowed?: boolean; commitLost?: boolean; forged?: boolean } = {},
) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    void _values;
    if (sql.includes("AS allowed"))
      return { rows: [{ allowed: options.allowed ?? true }] };
    if (sql.includes("AS permit"))
      return {
        rows: [
          {
            permit: options.forged
              ? { ...permit, intent: { ...intent, path: "forged" } }
              : permit,
          },
        ],
      };
    if (sql.includes("AS receipt")) return { rows: [{ receipt: id(8) }] };
    if (sql === "COMMIT" && options.commitLost) throw new Error("ACK_LOST");
    return { rows: [] };
  });
  const release = vi.fn();
  return { query, release, connect: vi.fn(async () => ({ query, release })) };
}
describe("PostgreSQL gateway fail-closed bindings", () => {
  it("uses bound scope and acknowledges only after COMMIT", async () => {
    const p = pool();
    expect(
      await new PostgresAuthority(p, trusted).consumeDispatch(intent),
    ).toEqual(permit);
    expect(p.query.mock.calls.map((x) => x[0]).at(-1)).toBe("COMMIT");
    expect(
      p.query.mock.calls.find((x) => x[0].includes("AS permit"))?.[1],
    ).toEqual([
      intent.ownerId,
      intent.requestId,
      intent.resourceId,
      intent.executorId,
      1,
      1,
    ]);
    expect(p.release).toHaveBeenCalledWith(undefined);
  });
  it("rejects administrator/incorrect sessions before switching", async () => {
    const p = pool({ allowed: false });
    await expect(
      new PostgresAuthority(p, trusted).consumeDispatch(intent),
    ).rejects.toThrow("RESTRICTED_RUNTIME_REQUIRED");
    expect(p.query.mock.calls.some((x) => x[0].startsWith("SET"))).toBe(false);
  });
  it("rejects independently unauthenticated scope before a connection", async () => {
    const p = pool();
    await expect(
      new PostgresAuthority(p, trusted).consumeDispatch({
        ...intent,
        ownerId: id(9),
      }),
    ).rejects.toThrow("FORBIDDEN");
    expect(p.connect).not.toHaveBeenCalled();
  });
  it("rolls back mismatched durable scope before commit", async () => {
    const p = pool({ forged: true });
    await expect(
      new PostgresAuthority(p, trusted).consumeDispatch(intent),
    ).rejects.toThrow("IDENTITY_MISMATCH");
    expect(p.query.mock.calls.some((x) => x[0] === "COMMIT")).toBe(false);
  });
  it("never retries lost dispatch commit and discards the connection", async () => {
    const p = pool({ commitLost: true });
    await expect(
      new PostgresAuthority(p, trusted).consumeDispatch(intent),
    ).rejects.toThrow("ACK_LOST");
    expect(
      p.query.mock.calls.filter((x) => x[0].includes("AS permit")),
    ).toHaveLength(1);
    expect(p.release).toHaveBeenCalledWith(expect.any(Error));
  });
  it("keeps stable intent/final operation keys and propagates persistence failure", async () => {
    const p = pool();
    const sink = new PostgresEvidence(p, trusted);
    await sink.append(observation);
    await sink.append(observation);
    const final = {
      ...observation,
      state: "ambiguous" as const,
      reason: "TIMEOUT",
    };
    await sink.append(final);
    await sink.append({ ...final, reason: "TRANSPORT_FAILURE" });
    const calls = p.query.mock.calls.filter((x) => x[0].includes("AS receipt"));
    expect(calls[0][1]?.[5]).toBe(calls[1][1]?.[5]);
    expect(calls[2][1]?.[5]).toBe(calls[3][1]?.[5]);
    expect(calls[0][1]?.[5]).not.toBe(calls[2][1]?.[5]);
    const lost = pool({ commitLost: true });
    await expect(
      new PostgresEvidence(lost, trusted).append(observation),
    ).rejects.toThrow("ACK_LOST");
  });
});
