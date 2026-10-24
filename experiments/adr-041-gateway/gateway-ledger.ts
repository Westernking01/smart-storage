/**
 * Local-only ADR-041 proof model. This is deliberately not an HTTP server or
 * a Supabase adapter: it specifies the checks a trusted streaming gateway must
 * make before it forwards any bytes to a storage provider.
 */
export class GatewayPolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export type Forwarder = (input: {
  path: string;
  chunks: AsyncIterable<Uint8Array>;
}) => Promise<{ observedBytes: number }>;

type Attempt = {
  id: string;
  path: string;
  epoch: number;
  maxBytes: number;
  state: "allocated" | "in-flight" | "ambiguous" | "present" | "settled";
  requestId?: string;
  observedBytes?: number;
};

type Session = {
  id: string;
  ownerId: string;
  heldBytes: number;
  maxConcurrent: number;
  expiresAt: number;
  state: "uploading" | "reconciling" | "completed" | "settled";
  activeRequests: number;
  attempts: Map<string, Attempt>;
};

type Account = {
  quotaBytes: number;
  reservedBytes: number;
  storedBytes: number;
  slots: number;
};

export class GatewayLedger {
  private readonly accounts = new Map<string, Account>();
  private readonly sessions = new Map<string, Session>();

  registerAccount(ownerId: string, quotaBytes: number) {
    this.accounts.set(ownerId, {
      quotaBytes,
      reservedBytes: 0,
      storedBytes: 0,
      slots: 0,
    });
  }

  reserve(input: {
    ownerId: string;
    sessionId: string;
    heldBytes: number;
    maxConcurrent: number;
    expiresAt: number;
  }) {
    const account = this.account(input.ownerId);
    if (
      !Number.isSafeInteger(input.heldBytes) ||
      input.heldBytes < 0 ||
      input.maxConcurrent < 1
    )
      throw new GatewayPolicyError("INVALID_RESERVATION");
    if (this.sessions.has(input.sessionId))
      throw new GatewayPolicyError("SESSION_EXISTS");
    if (
      account.storedBytes + account.reservedBytes + input.heldBytes >
      account.quotaBytes
    )
      throw new GatewayPolicyError("QUOTA_EXCEEDED");
    account.reservedBytes += input.heldBytes;
    account.slots += 1;
    this.sessions.set(input.sessionId, {
      id: input.sessionId,
      ownerId: input.ownerId,
      heldBytes: input.heldBytes,
      maxConcurrent: input.maxConcurrent,
      expiresAt: input.expiresAt,
      state: "uploading",
      activeRequests: 0,
      attempts: new Map(),
    });
  }

  allocate(input: {
    ownerId: string;
    sessionId: string;
    attemptId: string;
    path: string;
    epoch: number;
    maxBytes: number;
  }) {
    const session = this.session(input.sessionId);
    this.assertOwner(session, input.ownerId);
    if (
      session.state !== "uploading" ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 0
    )
      throw new GatewayPolicyError("ALLOCATION_BLOCKED");
    if (session.attempts.has(input.attemptId))
      throw new GatewayPolicyError("ATTEMPT_EXISTS");
    session.attempts.set(input.attemptId, {
      id: input.attemptId,
      path: input.path,
      epoch: input.epoch,
      maxBytes: input.maxBytes,
      state: "allocated",
    });
  }

  async upload(input: {
    ownerId: string;
    sessionId: string;
    attemptId: string;
    path: string;
    epoch: number;
    requestId: string;
    declaredBytes: number;
    now: number;
    chunks: AsyncIterable<Uint8Array>;
    forward: Forwarder;
  }) {
    const session = this.session(input.sessionId);
    this.assertOwner(session, input.ownerId);
    const attempt = session.attempts.get(input.attemptId);
    if (
      !attempt ||
      attempt.path !== input.path ||
      attempt.epoch !== input.epoch
    )
      throw new GatewayPolicyError("ATTEMPT_SCOPE_MISMATCH");
    if (input.now >= session.expiresAt || session.state !== "uploading")
      throw new GatewayPolicyError("SESSION_EXPIRED_OR_BLOCKED");
    if (
      !Number.isSafeInteger(input.declaredBytes) ||
      input.declaredBytes < 0 ||
      input.declaredBytes > attempt.maxBytes
    )
      throw new GatewayPolicyError("BODY_LIMIT_EXCEEDED");
    if (attempt.state === "present" && attempt.requestId === input.requestId)
      return {
        idempotent: true,
        observedBytes: attempt.observedBytes as number,
      };
    if (attempt.state !== "allocated")
      throw new GatewayPolicyError("ATTEMPT_REPLAY_OR_AMBIGUOUS");
    if (session.activeRequests >= session.maxConcurrent)
      throw new GatewayPolicyError("CONCURRENT_LIMIT_EXCEEDED");

    // The durable transition occurs before the provider is reachable. Any
    // interruption thereafter is intentionally ambiguous and cannot be retried.
    attempt.state = "in-flight";
    attempt.requestId = input.requestId;
    session.activeRequests += 1;
    let seen = 0;
    const bounded = this.boundChunks(
      input.chunks,
      input.declaredBytes,
      (bytes) => {
        seen += bytes;
      },
    );
    try {
      const result = await input.forward({
        path: attempt.path,
        chunks: bounded,
      });
      if (
        seen !== input.declaredBytes ||
        result.observedBytes !== input.declaredBytes
      )
        throw new GatewayPolicyError("PROVIDER_SIZE_MISMATCH");
      attempt.observedBytes = result.observedBytes;
      attempt.state = "present";
      return { idempotent: false, observedBytes: result.observedBytes };
    } catch (error) {
      attempt.state = "ambiguous";
      session.state = "reconciling";
      throw error;
    } finally {
      session.activeRequests -= 1;
    }
  }

  finalize(ownerId: string, sessionId: string) {
    const session = this.session(sessionId);
    this.assertOwner(session, ownerId);
    if (session.state === "completed") return;
    if (
      session.state !== "uploading" ||
      [...session.attempts.values()].some((a) => a.state !== "present")
    )
      throw new GatewayPolicyError("FINALIZATION_EVIDENCE_MISSING");
    const storedBytes = [...session.attempts.values()].reduce(
      (sum, attempt) => sum + (attempt.observedBytes as number),
      0,
    );
    if (storedBytes > session.heldBytes)
      throw new GatewayPolicyError("RESERVATION_OVERFLOW");
    const account = this.account(ownerId);
    account.reservedBytes -= session.heldBytes;
    account.storedBytes += storedBytes;
    account.slots -= 1;
    session.state = "completed";
  }

  settleAfterVerifiedRemoval(
    ownerId: string,
    sessionId: string,
    providerRemovalVerified: boolean,
  ) {
    const session = this.session(sessionId);
    this.assertOwner(session, ownerId);
    if (session.state === "settled") return;
    if (!providerRemovalVerified)
      throw new GatewayPolicyError("CLEANUP_PROOF_REQUIRED");
    const account = this.account(ownerId);
    if (session.state === "completed")
      account.storedBytes -= [...session.attempts.values()].reduce(
        (sum, a) => sum + (a.observedBytes ?? 0),
        0,
      );
    else {
      account.reservedBytes -= session.heldBytes;
      account.slots -= 1;
    }
    session.state = "settled";
    for (const attempt of session.attempts.values()) attempt.state = "settled";
  }

  usage(ownerId: string) {
    return { ...this.account(ownerId) };
  }
  attemptState(sessionId: string, attemptId: string) {
    return this.session(sessionId).attempts.get(attemptId)?.state;
  }

  private async *boundChunks(
    chunks: AsyncIterable<Uint8Array>,
    declaredBytes: number,
    count: (bytes: number) => void,
  ) {
    let forwarded = 0;
    for await (const chunk of chunks) {
      if (
        !(chunk instanceof Uint8Array) ||
        forwarded + chunk.byteLength > declaredBytes
      )
        throw new GatewayPolicyError("STREAM_LIMIT_EXCEEDED");
      forwarded += chunk.byteLength;
      count(chunk.byteLength);
      yield chunk;
    }
  }
  private account(ownerId: string) {
    const account = this.accounts.get(ownerId);
    if (!account) throw new GatewayPolicyError("ACCOUNT_NOT_FOUND");
    return account;
  }
  private session(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new GatewayPolicyError("SESSION_NOT_FOUND");
    return session;
  }
  private assertOwner(session: Session, ownerId: string) {
    if (session.ownerId !== ownerId)
      throw new GatewayPolicyError("OWNER_MISMATCH");
  }
}
