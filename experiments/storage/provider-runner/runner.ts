import { randomUUID } from "node:crypto";
import {
  PROJECT,
  RUN,
  USERS,
  PATHS,
  MANIFEST_HASH,
  STAGES,
  TUS_BYTES,
  approve,
  boundResource,
  validateIntent,
  hash,
  type Approval,
  type Intent,
} from "./manifest.js";
import { Ledger, type Entry } from "./ledger.js";
import { isCrossReadDenial, type ProviderError } from "./denial.js";
import { assertContinuation } from "./continuation.js";
import { usableSession } from "./session.js";
import { renewalBytes } from "./renewal-evidence.js";

export interface Response {
  status: number;
  offset?: number;
  length?: number;
  location?: string;
  json?: Record<string, unknown>;
  digest?: string;
  responseBytes?: number;
  errorCode?: string;
  providerError?: ProviderError;
}
export interface Transport {
  send(intent: Intent, token?: string): Promise<Response>;
}
export interface Credentials {
  get(actor: "A" | "B"): { id: string; email: string; password: string };
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z_]{3,80}$/.test(message) ? message : "FAIL_CLOSED";
}
export function summary(ledger: Ledger) {
  return {
    run: RUN,
    attemptedAllocations: ledger.state.allocations,
    attemptedBodyBytes: ledger.state.bytes + renewalBytes(ledger.state),
    stageBodyBytes: ledger.state.bytes,
    attemptedRenewalBodyBytes: renewalBytes(ledger.state),
    totalAttemptedBodyBytes: ledger.state.bytes + renewalBytes(ledger.state),
    halted: ledger.state.halted ?? null,
    continuationBlocked: ledger.isHalted(),
    reconciledStages: ledger.isReconciled("cross-read-B")
      ? ["cross-read-B"]
      : [],
    requests: ledger.state.entries.map((e) => ({
      id: e.id,
      actor: e.actor,
      slot: e.path ? PATHS.findIndex((p) => p.path === e.path) : null,
      method: e.method,
      purpose: e.purpose,
      allocationAttempt: e.allocationAttempt,
      bodyBytes: e.bodyBytes,
      cumulativeBytes: e.cumulativeBytes,
      status: e.status ?? null,
      state: e.state,
      cleanup: e.cleanup,
    })),
  };
}
export function dryRun() {
  return {
    mode: "DRY_RUN",
    providerRequests: 0,
    credentialsRead: false,
    ledgerModified: false,
    manifestHash: MANIFEST_HASH,
    permittedPaths: 12,
    firstWaveAllocationAttempts: 3,
    firstWaveMaximumBodyBytes: STAGES.reduce((n, s) => n + s.maxBytes, 0),
    reservedAllocationCapacity: 9,
    stages: STAGES.map((s) => ({
      id: s.id,
      actor: s.actor,
      purpose: s.purpose,
      method: s.method,
      slot: "path" in s ? PATHS.findIndex((p) => p.path === s.path) : null,
      maxBodyBytes: s.maxBytes,
    })),
    ownerVerification:
      "Ordinary info route may omit owner; require subsequent read-only catalog evidence before cleanup eligibility.",
  };
}
export class Runner {
  private busy = false;
  constructor(
    readonly ledger: Ledger,
    private readonly transport: Transport,
    private readonly authorization?: Approval,
    private readonly confirmation?: string,
    private readonly dry = true,
  ) {}
  async send(intent: Intent): Promise<Response | undefined> {
    if (this.dry) return undefined;
    if (this.busy) throw new Error("SEQUENTIAL_EXECUTION_REQUIRED");
    const permission = approve(
      this.authorization,
      this.confirmation,
      intent.purpose === "cleanup",
    );
    if (!permission.purposes.includes(intent.purpose))
      throw new Error("PURPOSE_NOT_APPROVED");
    assertContinuation(this.ledger, permission, intent);
    const candidates = this.ledger.cleanupPreview();
    const validation = validateIntent(
      intent,
      candidates.map((x) => x.path),
    );
    let token: string | undefined;
    if (intent.actor !== "anonymous" && intent.purpose !== "login") {
      const session = this.ledger.state.sessions[intent.actor];
      if (!session || (!session.verified && intent.purpose !== "identity"))
        throw new Error("VERIFIED_ORDINARY_SESSION_REQUIRED");
      token = session.token;
      if (!usableSession(token, intent.actor))
        throw new Error("SESSION_EXPIRED_RENEWAL_REQUIRED");
    }
    if (intent.purpose.startsWith("tus-") && intent.purpose !== "tus-create") {
      const resource =
        intent.resource && this.ledger.state.resources[intent.resource];
      if (
        !resource ||
        resource.actor !== intent.actor ||
        resource.path !== intent.path ||
        boundResource(resource.url, resource.path) !== resource.url
      )
        throw new Error("RESOURCE_BINDING_REQUIRED");
      if (
        intent.purpose === "tus-part" &&
        (intent.offset !== resource.offset ||
          resource.complete ||
          !intent.body ||
          resource.offset + intent.body.byteLength > TUS_BYTES)
      )
        throw new Error("OFFSET_MISMATCH");
    }
    this.busy = true;
    let entry: Entry | undefined;
    try {
      entry = this.ledger.reserve(intent, validation.allocation);
      let response: Response;
      try {
        response = await this.transport.send(intent, token);
      } catch {
        this.ledger.update((s) => {
          s.entries[entry!.sequence - 1].state = "ambiguous";
          s.entries[entry!.sequence - 1].cleanup = "uncertain";
          s.halted = "NETWORK_RESULT_AMBIGUOUS";
        });
        throw new Error("NETWORK_RESULT_AMBIGUOUS");
      }
      const validDenial =
        intent.expected === "deny" &&
        ([401, 403, 404].includes(response.status) ||
          isCrossReadDenial(
            intent,
            response.status,
            response.providerError,
            this.ledger.knownObject(),
          ));
      this.ledger.update((s) => {
        const e = s.entries[entry!.sequence - 1];
        e.status = response.status;
        e.providerError = response.providerError;
        e.state =
          (response.status >= 200 && response.status < 300) || validDenial
            ? "completed"
            : "failed";
      });
      if (response.errorCode) throw new Error(response.errorCode);
      if (
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599
      )
        throw new Error("INVALID_HTTP_STATUS");
      if (intent.expected === "deny") {
        if (response.status >= 200 && response.status < 300)
          throw new Error("UNEXPECTED_SUCCESS_FOR_DENIAL");
        if (!validDenial) throw new Error("DENIAL_NOT_ESTABLISHED");
        return response;
      }
      const expected =
        intent.purpose === "tus-create"
          ? [201]
          : intent.purpose === "tus-part"
            ? [204]
            : intent.purpose === "cleanup"
              ? [200, 204]
              : intent.purpose === "rest-upload"
                ? [200, 201]
                : [200];
      if (!expected.includes(response.status))
        throw new Error("UNEXPECTED_HTTP_STATUS");
      if (intent.purpose === "login") {
        const json = response.json;
        const access = json?.access_token;
        if (
          intent.actor === "anonymous" ||
          typeof access !== "string" ||
          access.length < 16 ||
          access.startsWith("sb_")
        )
          throw new Error("ORDINARY_AUTH_TOKEN_REQUIRED");
        // Decoded claims are only a safety filter; GET /auth/v1/user establishes identity.
        let claims: { role?: string; sub?: string };
        try {
          claims = JSON.parse(
            Buffer.from(access.split(".")[1], "base64url").toString("utf8"),
          );
        } catch {
          throw new Error("ORDINARY_AUTH_TOKEN_REQUIRED");
        }
        if (
          claims.role !== "authenticated" ||
          claims.sub !== USERS[intent.actor].id
        )
          throw new Error("ORDINARY_AUTH_TOKEN_REQUIRED");
        this.ledger.update((s) => {
          s.sessions[intent.actor as "A" | "B"] = {
            token: access,
            verified: false,
          };
        });
      }
      if (intent.purpose === "identity") {
        const user = response.json;
        if (
          intent.actor === "anonymous" ||
          user?.id !== USERS[intent.actor].id ||
          user.email !== USERS[intent.actor].email ||
          user.role !== "authenticated" ||
          user.is_anonymous === true
        )
          throw new Error("IDENTITY_MISMATCH");
        this.ledger.update((s) => {
          s.sessions[intent.actor as "A" | "B"]!.verified = true;
        });
      }
      if (
        intent.purpose === "download" &&
        (response.responseBytes !== 256 ||
          response.digest !==
            hash(
              Uint8Array.from({ length: 256 }, (_, i) => (i * 31 + 17) % 251),
            ))
      )
        throw new Error("DOWNLOAD_BYTES_MISMATCH");
      if (intent.purpose === "tus-create") {
        if (!response.location || !intent.path)
          throw new Error("RESOURCE_BINDING_REQUIRED");
        const ref = randomUUID();
        // Retain even an unexpected Location privately for later reconciliation,
        // but never send to it unless it passes exact host/path binding.
        this.ledger.update((s) => {
          s.resources[ref] = {
            url: response.location!,
            path: intent.path!,
            actor: intent.actor,
            offset: 0,
            complete: false,
          };
          s.entries[entry!.sequence - 1].resourceRef = ref;
        });
        boundResource(response.location, intent.path);
      }
      if (intent.purpose === "tus-head" || intent.purpose === "tus-part") {
        const resource = this.ledger.state.resources[intent.resource!];
        const expectedOffset =
          intent.purpose === "tus-part"
            ? resource.offset + intent.body!.byteLength
            : resource.offset;
        if (
          response.offset !== expectedOffset ||
          (intent.purpose === "tus-head" && response.length !== TUS_BYTES)
        )
          throw new Error("OFFSET_MISMATCH");
        this.ledger.update((s) => {
          const r = s.resources[intent.resource!];
          r.offset = expectedOffset;
          r.complete = expectedOffset === TUS_BYTES;
          s.entries[entry!.sequence - 1].offset = expectedOffset;
        });
      }
      if (
        intent.purpose === "owner-info" &&
        typeof response.json?.owner_id === "string" &&
        intent.path
      ) {
        this.ledger.observeOwner(
          intent.path,
          response.json.owner_id,
          "ordinary-provider-info-response",
        );
        if (
          intent.actor === "anonymous" ||
          response.json.owner_id !== USERS[intent.actor].id
        )
          throw new Error("OWNER_METADATA_MISMATCH");
      }
      if (intent.purpose === "cleanup")
        this.ledger.update((s) => {
          for (const e of s.entries)
            if (e.path === intent.path) e.cleanup = "uncertain";
        });
      return response;
    } catch (error) {
      // If reservation persistence failed, never attempt a transport or a second write.
      if (
        entry &&
        (!this.ledger.state.halted ||
          (this.ledger.state.halted === "DENIAL_NOT_ESTABLISHED" &&
            this.ledger.isReconciled("cross-read-B")))
      )
        this.ledger.halt(safeError(error));
      throw new Error(safeError(error));
    } finally {
      this.busy = false;
    }
  }
  async authenticate(
    actor: "A" | "B",
    credentials: Credentials,
  ): Promise<void> {
    if (this.dry) return;
    approve(this.authorization, this.confirmation);
    if (
      this.authorization?.schemaVersion === 2 &&
      !this.ledger.state.sessions[actor]?.verified
    )
      throw new Error("CONTINUATION_SESSION_REQUIRED");
    if (this.ledger.state.sessions[actor]?.verified) {
      if (!usableSession(this.ledger.state.sessions[actor]!.token, actor))
        throw new Error("SESSION_EXPIRED_RENEWAL_REQUIRED");
      return;
    }
    const c = credentials.get(actor);
    if (
      c.id !== USERS[actor].id ||
      c.email !== USERS[actor].email ||
      c.password.length < 24
    )
      throw new Error("PROTECTED_CREDENTIAL_MISMATCH");
    await this.send({
      id: `login-${actor}`,
      actor,
      purpose: "login",
      method: "POST",
      body: Buffer.from(
        JSON.stringify({ email: c.email, password: c.password }),
      ),
      expected: "allow",
    });
    await this.send({
      id: `identity-${actor}`,
      actor,
      purpose: "identity",
      method: "GET",
      expected: "allow",
    });
  }
}
export function assertProject(url: string): void {
  if (new URL(url).href !== `https://${PROJECT}.supabase.co/`)
    throw new Error("PROJECT_MISMATCH");
}
