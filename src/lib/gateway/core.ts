/**
 * Production-oriented ADR-041 gateway core. Adapters own authentication,
 * durable authority transitions, and provider I/O; this module never imports a
 * browser client, Supabase SDK, or credential.
 */
export class GatewayError extends Error {
  constructor(
    public readonly code:
      | "UNAUTHENTICATED"
      | "INVALID_DECLARED_LENGTH"
      | "ATTEMPT_FORBIDDEN"
      | "ATTEMPT_AMBIGUOUS"
      | "STREAM_TOO_LARGE"
      | "STREAM_TRUNCATED"
      | "PROVIDER_SIZE_MISMATCH"
      | "FINALIZATION_BLOCKED"
      | "CLEANUP_PROOF_REQUIRED",
  ) {
    super(code);
  }
}

export type GatewayIdentity = Readonly<{ ownerId: string }>;
/** Durable, consumed dispatch grant; an adapter must resolve registered resources. */
export type GatewayWriteAuthorization = Readonly<{
  ownerId: string;
  requestId: string;
  resourceId: string;
  executorId: string;
  dispatchGeneration: number;
  epoch: number;
  bucket: string;
  path: string;
}>;
export type AttemptAuthority = Readonly<{
  ownerId: string;
  sessionId: string;
  attemptId: string;
  epoch: number;
  bucket: string;
  path: string;
  maximumEncodedBytes: number;
}>;
export type ClaimResult =
  | Readonly<{ kind: "claimed"; authority: AttemptAuthority }>
  | Readonly<{ kind: "committed"; acceptedBytes: number; storedBytes: number }>
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "forbidden" }>;

export interface GatewayAuthentication {
  authenticate(request: {
    authorization?: string;
  }): Promise<GatewayIdentity | null>;
}
export interface GatewayAuthorityStore {
  /** Register bounded exposure, then consume the trusted one-time dispatch RPC.
   * Manifest, temporary and SDK-managed writes require this same boundary.
   */
  authorizeWrite(input: {
    ownerId: string;
    requestId: string;
    authority: AttemptAuthority;
  }): Promise<GatewayWriteAuthorization>;
  /** Atomically validates owner/session/attempt/epoch and claims the request ID. */
  claim(input: {
    ownerId: string;
    attemptReference: string;
    requestId: string;
    declaredBytes: number;
    now: number;
  }): Promise<ClaimResult>;
  markAmbiguous(input: {
    attemptId: string;
    requestId: string;
    reason: string;
  }): Promise<void>;
  /** Resolve independent committed/hash and terminal-writer proofs. Counts alone
   * must never certify commitment or release stream/reserved-byte capacity.
   */
  markCommitted(input: {
    attemptId: string;
    requestId: string;
    acceptedBytes: number;
    storedBytes: number;
  }): Promise<void>;
  finalizationEvidence(
    sessionReference: string,
    ownerId: string,
  ): Promise<
    ReadonlyArray<
      AttemptAuthority & {
        state: "committed" | "ambiguous" | "allocated";
        storedBytes?: number;
      }
    >
  >;
  commitFinalization(input: {
    sessionReference: string;
    ownerId: string;
    expectedEncodedBytes: number;
  }): Promise<void>;
  beginCleanup(input: {
    sessionReference: string;
    ownerId: string;
  }): Promise<ReadonlyArray<AttemptAuthority>>;
  recordVerifiedRemoval(input: {
    sessionReference: string;
    ownerId: string;
    attemptId: string;
  }): Promise<void>;
  settleCleanup(input: {
    sessionReference: string;
    ownerId: string;
  }): Promise<void>;
}
export interface GatewayStorageProvider {
  write(input: {
    authorization: GatewayWriteAuthorization;
    bucket: string;
    path: string;
    bytes: AsyncIterable<Uint8Array>;
  }): Promise<{ storedBytes: number }>;
  inspect(input: {
    bucket: string;
    path: string;
  }): Promise<{ exists: boolean; storedBytes?: number }>;
  remove(input: { bucket: string; path: string }): Promise<void>;
}

export class TrustedUploadGateway {
  constructor(
    private readonly authentication: GatewayAuthentication,
    private readonly authority: GatewayAuthorityStore,
    private readonly storage: GatewayStorageProvider,
  ) {}

  async upload(input: {
    authorization?: string;
    attemptReference: string;
    requestId: string;
    declaredBytes: number;
    now: number;
    bytes: AsyncIterable<Uint8Array>;
  }) {
    if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 0)
      throw new GatewayError("INVALID_DECLARED_LENGTH");
    const identity = await this.authentication.authenticate({
      authorization: input.authorization,
    });
    if (!identity) throw new GatewayError("UNAUTHENTICATED");
    const claim = await this.authority.claim({
      ownerId: identity.ownerId,
      attemptReference: input.attemptReference,
      requestId: input.requestId,
      declaredBytes: input.declaredBytes,
      now: input.now,
    });
    if (claim.kind === "committed")
      return {
        replay: true,
        acceptedBytes: claim.acceptedBytes,
        storedBytes: claim.storedBytes,
      };
    if (claim.kind === "ambiguous") throw new GatewayError("ATTEMPT_AMBIGUOUS");
    if (claim.kind !== "claimed") throw new GatewayError("ATTEMPT_FORBIDDEN");
    const attempt = claim.authority;
    if (input.declaredBytes > attempt.maximumEncodedBytes)
      throw new GatewayError("INVALID_DECLARED_LENGTH");

    let acceptedBytes = 0;
    const bounded = this.limit(
      input.bytes,
      input.declaredBytes,
      attempt.maximumEncodedBytes,
      (count) => {
        acceptedBytes += count;
      },
    );
    try {
      const authorization = await this.authority.authorizeWrite({
        ownerId: identity.ownerId,
        requestId: input.requestId,
        authority: attempt,
      });
      if (
        authorization.ownerId !== identity.ownerId ||
        authorization.requestId !== input.requestId ||
        authorization.epoch !== attempt.epoch ||
        authorization.bucket !== attempt.bucket ||
        authorization.path !== attempt.path ||
        !authorization.resourceId ||
        !authorization.executorId ||
        authorization.dispatchGeneration !== 1
      )
        throw new GatewayError("ATTEMPT_FORBIDDEN");
      const result = await this.storage.write({
        authorization,
        bucket: attempt.bucket,
        path: attempt.path,
        bytes: bounded,
      });
      if (acceptedBytes !== input.declaredBytes)
        throw new GatewayError("STREAM_TRUNCATED");
      if (result.storedBytes !== acceptedBytes)
        throw new GatewayError("PROVIDER_SIZE_MISMATCH");
      await this.authority.markCommitted({
        attemptId: attempt.attemptId,
        requestId: input.requestId,
        acceptedBytes,
        storedBytes: result.storedBytes,
      });
      return { replay: false, acceptedBytes, storedBytes: result.storedBytes };
    } catch (error) {
      // A provider write may have happened even if the gateway did not receive
      // its response. Durable reconciliation is required before any retry.
      await this.authority.markAmbiguous({
        attemptId: attempt.attemptId,
        requestId: input.requestId,
        reason:
          error instanceof GatewayError
            ? error.code
            : "PROVIDER_OR_TRANSPORT_FAILURE",
      });
      throw error;
    }
  }

  async finalize(input: {
    authorization?: string;
    sessionReference: string;
    expectedEncodedBytes: number;
  }) {
    const identity = await this.authentication.authenticate({
      authorization: input.authorization,
    });
    if (!identity) throw new GatewayError("UNAUTHENTICATED");
    const evidence = await this.authority.finalizationEvidence(
      input.sessionReference,
      identity.ownerId,
    );
    if (
      !evidence.length ||
      evidence.some(
        (attempt) =>
          attempt.state !== "committed" ||
          attempt.storedBytes !== attempt.maximumEncodedBytes,
      )
    )
      throw new GatewayError("FINALIZATION_BLOCKED");
    const total = evidence.reduce(
      (sum, attempt) => sum + (attempt.storedBytes ?? 0),
      0,
    );
    if (total !== input.expectedEncodedBytes)
      throw new GatewayError("FINALIZATION_BLOCKED");
    await this.authority.commitFinalization({
      sessionReference: input.sessionReference,
      ownerId: identity.ownerId,
      expectedEncodedBytes: total,
    });
  }

  async cleanup(input: { authorization?: string; sessionReference: string }) {
    const identity = await this.authentication.authenticate({
      authorization: input.authorization,
    });
    if (!identity) throw new GatewayError("UNAUTHENTICATED");
    const attempts = await this.authority.beginCleanup({
      sessionReference: input.sessionReference,
      ownerId: identity.ownerId,
    });
    for (const attempt of attempts) {
      const before = await this.storage.inspect({
        bucket: attempt.bucket,
        path: attempt.path,
      });
      if (before.exists)
        await this.storage.remove({
          bucket: attempt.bucket,
          path: attempt.path,
        });
      const after = await this.storage.inspect({
        bucket: attempt.bucket,
        path: attempt.path,
      });
      if (after.exists) throw new GatewayError("CLEANUP_PROOF_REQUIRED");
    }
    // This legacy size/visibility-only interface has no terminal-writer or
    // complete-resource-discovery evidence. Even absence after DELETE cannot
    // authorize quota release: a delayed writer may still recreate the object.
    // Settlement belongs exclusively to the evidence-qualified SQL lifecycle.
    throw new GatewayError("CLEANUP_PROOF_REQUIRED");
  }

  private async *limit(
    source: AsyncIterable<Uint8Array>,
    declared: number,
    maximum: number,
    accepted: (count: number) => void,
  ) {
    let total = 0;
    for await (const chunk of source) {
      if (
        !(chunk instanceof Uint8Array) ||
        total + chunk.byteLength > declared ||
        total + chunk.byteLength > maximum
      )
        throw new GatewayError("STREAM_TOO_LARGE");
      total += chunk.byteLength;
      accepted(chunk.byteLength);
      yield chunk;
    }
  }
}
