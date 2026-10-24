import { randomBytes } from "node:crypto";
import {
  PROJECT,
  BUCKET,
  RUN,
  MANIFEST_HASH,
  USERS,
  STAGES,
  type Approval,
} from "./manifest.js";
import { Ledger } from "./ledger.js";
import { continuationCheckpoint, assertContinuation } from "./continuation.js";
import {
  approveRenewal,
  renewalBytes,
  type RenewalApproval,
  type RenewalEvent,
} from "./renewal-evidence.js";
import { usableSession, expiredOrdinarySession } from "./session.js";
import type { Credentials } from "./runner.js";

export function renewalCandidate(
  ledger: Ledger,
  second = false,
): RenewalApproval {
  const now = Date.now();
  const c = continuationCheckpoint(ledger);
  if (second) {
    const events = ledger.state.renewalEvents;
    if (
      !events ||
      events.length !== 4 ||
      events.some((e) => e.state !== "completed")
    )
      throw new Error("SECOND_RENEWAL_REQUIRES_COMPLETED_FIRST");
    if (
      (["A", "B"] as const).every((actor) =>
        usableSession(
          ledger.state.sessions[actor]!.token,
          actor as "A" | "B",
          now,
          1800000,
        ),
      )
    )
      throw new Error("SECOND_RENEWAL_NOT_NEEDED");
  } else if (ledger.state.renewalEvents?.length)
    throw new Error("SESSION_RENEWAL_ALREADY_ATTEMPTED");
  for (const actor of ["A", "B"] as const) {
    const s = ledger.state.sessions[actor];
    if (!s?.verified || (!second && !expiredOrdinarySession(s.token, actor)))
      throw new Error("EXPIRED_VERIFIED_SESSION_REQUIRED");
  }
  return {
    version: 1,
    ...(second ? { round: 2 as const } : {}),
    kind: "storage-session-renewal",
    id: randomBytes(32).toString("hex"),
    project: PROJECT,
    bucket: BUCKET,
    run: RUN,
    manifestHash: MANIFEST_HASH,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1800000).toISOString(),
    ledgerIdentity: c.ledgerIdentity,
    generation: c.generation,
    digest: c.digest,
    actors: ["A", "B"],
    maxBodyBytes: 32550,
  };
}
function scope(p: RenewalApproval): Approval {
  return {
    schemaVersion: 2,
    kind: "storage-provider-execution",
    id: p.id,
    project: p.project,
    bucket: p.bucket,
    run: p.run,
    manifestHash: p.manifestHash,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    purposes: [...new Set(STAGES.slice(7).map((s) => s.purpose))],
    acknowledgedRuntimeUncertainties: true,
    continuation: {
      ledgerIdentity: p.ledgerIdentity,
      generation: p.generation,
      digest: p.digest,
      stages: STAGES.slice(7).map((s) => s.id),
      initialAllocations: 1,
      initialBytes: 474,
      maxAdditionalAllocations: 2,
      maxAdditionalBytes: 6292512,
    },
  };
}
export const SECOND_RENEWAL_PROMPT =
  "Target mdyiczsuddpqgjtfofgs / smart-storage-feasibility / p14b-20261011-c40e8e03. Second renewal: exactly 4 Auth requests for ordinary A/B; cumulative Auth body cap 32,550 bytes, including first renewal. No Storage authorized yet; no retries or third renewal. Type AUTHORIZE SECOND SESSION RENEWAL: ";
export async function confirmSecondRenewal(
  ledger: Ledger,
  question: (prompt: string) => Promise<string>,
  create: (p: RenewalApproval) => string,
  check: () => void,
) {
  check();
  const initial = renewalCandidate(ledger, true);
  assertContinuation(ledger, scope(initial));
  if (
    (await question(SECOND_RENEWAL_PROMPT)) !==
    "AUTHORIZE SECOND SESSION RENEWAL"
  )
    throw new Error("SESSION_RENEWAL_NOT_CONFIRMED");
  check();
  const permission = renewalCandidate(ledger, true);
  assertContinuation(ledger, scope(permission));
  return { permission, file: create(permission) };
}
export interface RenewalRequest {
  actor: "A" | "B";
  operation: "login" | "identity";
  body?: Uint8Array;
  token?: string;
}
export interface RenewalResponse {
  status: number;
  json: Record<string, unknown>;
}
export interface RenewalTransport {
  send(request: RenewalRequest): Promise<RenewalResponse>;
}
export async function renewSessions(
  ledger: Ledger,
  p: RenewalApproval,
  confirmation: string,
  credentials: Credentials,
  transport: RenewalTransport,
  checkAcl: () => void,
): Promise<void> {
  approveRenewal(p, confirmation);
  checkAcl();
  ledger.load();
  assertContinuation(ledger, scope(p));
  renewalCandidate(ledger, p.round === 2);
  const checkpoint = continuationCheckpoint(ledger);
  if (
    checkpoint.ledgerIdentity !== p.ledgerIdentity ||
    checkpoint.generation !== p.generation ||
    checkpoint.digest !== p.digest
  )
    throw new Error("SESSION_RENEWAL_CHECKPOINT_INVALID");
  // Both bodies are validated before any request, so one bad credential cannot
  // cause a partial account renewal. Credential plaintext never enters the journal.
  const bodies = {} as Record<"A" | "B", Uint8Array>;
  for (const actor of ["A", "B"] as const) {
    const c = credentials.get(actor);
    if (
      c.id !== USERS[actor].id ||
      c.email !== USERS[actor].email ||
      typeof c.password !== "string" ||
      c.password.length < 24
    )
      throw new Error("PROTECTED_CREDENTIAL_MISMATCH");
    bodies[actor] = Buffer.from(
      JSON.stringify({ email: c.email, password: c.password }),
    );
    if (bodies[actor].byteLength > 16384)
      throw new Error("SESSION_RENEWAL_BODY_LIMIT");
  }
  if (
    renewalBytes(ledger.state) + bodies.A.byteLength + bodies.B.byteLength >
      p.maxBodyBytes ||
    ledger.state.bytes +
      renewalBytes(ledger.state) +
      6292512 +
      bodies.A.byteLength +
      bodies.B.byteLength >
      6325536
  )
    throw new Error("SESSION_RENEWAL_BUDGET_EXHAUSTED");
  for (const actor of ["A", "B"] as const) {
    const previousSession = structuredClone(ledger.state.sessions[actor]!);
    let token: string | undefined;
    for (const operation of ["login", "identity"] as const) {
      approveRenewal(p, confirmation);
      checkAcl();
      assertContinuation(ledger, scope(p));
      const event: RenewalEvent = {
        actor,
        operation,
        state: "reserved",
        at: new Date().toISOString(),
        bytes: operation === "login" ? bodies[actor].byteLength : 0,
        approval: structuredClone(p),
        previousSession,
      };
      ledger.update((s) => {
        (s.renewalEvents ??= []).push(event);
      });
      const index = ledger.state.renewalEvents!.length - 1;
      let response: RenewalResponse;
      ledger.load();
      approveRenewal(p, confirmation);
      checkAcl();
      assertContinuation(ledger, scope(p));
      try {
        response = await transport.send({
          actor,
          operation,
          body: operation === "login" ? bodies[actor] : undefined,
          token,
        });
      } catch {
        // Never append another row after an incomplete/corrupt commit.
        ledger.load();
        ledger.update((s) => {
          s.renewalEvents![index].state = "ambiguous";
        });
        throw new Error("SESSION_RENEWAL_INTERRUPTED");
      }
      try {
        if (response.status !== 200)
          throw new Error("SESSION_RENEWAL_UNEXPECTED_STATUS");
        if (operation === "login") {
          const candidate = response.json.access_token;
          if (
            typeof candidate !== "string" ||
            !usableSession(candidate, actor, Date.now(), 60000)
          )
            throw new Error("SESSION_RENEWAL_TOKEN_INVALID");
          token = candidate;
        } else {
          const u = response.json;
          if (
            u.id !== USERS[actor].id ||
            u.email !== USERS[actor].email ||
            u.role !== "authenticated" ||
            u.is_anonymous !== false ||
            !token ||
            !usableSession(token, actor, Date.now(), 60000)
          )
            throw new Error("SESSION_RENEWAL_IDENTITY_INVALID");
        }
        ledger.update((s) => {
          const e = s.renewalEvents![index];
          e.state = "completed";
          e.status = response.status;
          e.token = token;
          if (operation === "identity") {
            e.identity = {
              ...USERS[actor],
              role: "authenticated",
              is_anonymous: false,
            };
            s.sessions[actor] = { token: token!, verified: true };
          }
        });
      } catch {
        // A completion commit may have failed after journal fsync or even
        // after becoming durable. Never append to an incomplete commit and
        // never relabel a committed response as a failed request.
        ledger.load();
        if (ledger.state.renewalEvents![index].state === "completed")
          throw new Error("SESSION_RENEWAL_POST_COMMIT_STOP");
        ledger.update((s) => {
          s.renewalEvents![index].state = "failed";
          s.renewalEvents![index].status = response.status;
        });
        throw new Error("SESSION_RENEWAL_VERIFICATION_FAILED");
      }
    }
  }
  assertContinuation(ledger, scope(p));
  if (renewalBytes(ledger.state) > p.maxBodyBytes)
    throw new Error("SESSION_RENEWAL_BUDGET_EXHAUSTED");
}

export class NativeRenewalHttp implements RenewalTransport {
  constructor(
    private key: string,
    private p: RenewalApproval,
    private confirmation: string,
    private acl: () => void,
    private ledger: Ledger,
    private fetcher: typeof fetch = fetch,
  ) {
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))
      throw new Error("PUBLISHABLE_KEY_REQUIRED");
  }
  async send(r: RenewalRequest): Promise<RenewalResponse> {
    approveRenewal(this.p, this.confirmation);
    this.acl();
    if (
      !this.p.actors.includes(r.actor) ||
      !["login", "identity"].includes(r.operation) ||
      (r.operation === "login" &&
        (!r.body || r.body.byteLength > 16384 || r.token)) ||
      (r.operation === "identity" &&
        (!r.token || r.body || !usableSession(r.token, r.actor)))
    )
      throw new Error("SESSION_RENEWAL_REQUEST_INVALID");
    const headers: Record<string, string> = { apikey: this.key };
    if (r.operation === "login") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.from(r.body!).toString("utf8"));
      } catch {
        throw new Error("SESSION_RENEWAL_REQUEST_INVALID");
      }
      if (
        !body ||
        JSON.stringify(Object.keys(body).sort()) !== '["email","password"]' ||
        body.email !== USERS[r.actor].email ||
        typeof body.password !== "string" ||
        body.password.length < 24
      )
        throw new Error("SESSION_RENEWAL_REQUEST_INVALID");
    }
    if (r.token) headers.Authorization = `Bearer ${r.token}`;
    this.ledger.load();
    assertContinuation(this.ledger, scope(this.p));
    const event = this.ledger.state.renewalEvents?.at(-1);
    if (
      !event ||
      event.state !== "reserved" ||
      event.actor !== r.actor ||
      event.operation !== r.operation ||
      event.bytes !== (r.body?.byteLength ?? 0) ||
      JSON.stringify(event.approval) !== JSON.stringify(this.p)
    )
      throw new Error("SESSION_RENEWAL_RESERVATION_REQUIRED");
    if (
      r.operation === "identity" &&
      this.ledger.state.renewalEvents?.at(-2)?.token !== r.token
    )
      throw new Error("SESSION_RENEWAL_TOKEN_INVALID");
    this.ledger.update((s) => {
      s.renewalEvents!.at(-1)!.state = "dispatched";
    });
    approveRenewal(this.p, this.confirmation);
    this.acl();
    if (r.operation === "login") headers["Content-Type"] = "application/json";
    const response = await this.fetcher(
      `https://${PROJECT}.supabase.co/auth/v1/${r.operation === "login" ? "token?grant_type=password" : "user"}`,
      {
        method: r.operation === "login" ? "POST" : "GET",
        headers,
        body: r.body ? Buffer.from(r.body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, json: {} };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SESSION_RENEWAL_RESPONSE_INVALID");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 65536) throw new Error("SESSION_RENEWAL_RESPONSE_LIMIT");
        chunks.push(item.value);
      }
    } catch {
      await reader.cancel();
      throw new Error("SESSION_RENEWAL_RESPONSE_INVALID");
    }
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new Error("SESSION_RENEWAL_RESPONSE_INVALID");
    return { status: response.status, json };
  }
}
