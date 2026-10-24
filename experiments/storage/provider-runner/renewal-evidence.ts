import { PROJECT, BUCKET, RUN, MANIFEST_HASH, USERS } from "./manifest.js";
import { usableSession, expiredOrdinarySession } from "./session.js";
import type { State } from "./ledger.js";
export interface RenewalApproval {
  version: 1;
  round?: 2;
  kind: "storage-session-renewal";
  id: string;
  project: string;
  bucket: string;
  run: string;
  manifestHash: string;
  issuedAt: string;
  expiresAt: string;
  ledgerIdentity: string;
  generation: number;
  digest: string;
  actors: ["A", "B"];
  maxBodyBytes: 32550;
}
export interface RenewalEvent {
  actor: "A" | "B";
  operation: "login" | "identity";
  state: "reserved" | "dispatched" | "completed" | "failed" | "ambiguous";
  at: string;
  bytes: number;
  approval: RenewalApproval;
  previousSession: { token: string; verified: boolean };
  token?: string;
  status?: number;
  identity?: { id: string; email: string; role: string; is_anonymous: false };
}
export function approveRenewal(
  p: RenewalApproval,
  confirmation: string,
  now = Date.now(),
): void {
  const start = Date.parse(p.issuedAt),
    end = Date.parse(p.expiresAt);
  if (
    !Number.isFinite(now) ||
    p.version !== 1 ||
    (p.round !== undefined && p.round !== 2) ||
    p.kind !== "storage-session-renewal" ||
    !/^[a-f0-9]{64}$/.test(p.id) ||
    confirmation !== p.id ||
    p.project !== PROJECT ||
    p.bucket !== BUCKET ||
    p.run !== RUN ||
    p.manifestHash !== MANIFEST_HASH ||
    !Number.isFinite(start) ||
    start > now ||
    !Number.isFinite(end) ||
    end <= now ||
    end - start > 1800000 ||
    !/^[a-f0-9]{64}$/.test(p.ledgerIdentity) ||
    !/^[a-f0-9]{64}$/.test(p.digest) ||
    !Number.isSafeInteger(p.generation) ||
    p.generation < 0 ||
    JSON.stringify(p.actors) !== '["A","B"]' ||
    p.maxBodyBytes !== 32550
  )
    throw new Error("SESSION_RENEWAL_APPROVAL_REQUIRED");
}
export function renewalBytes(s: State): number {
  return (s.renewalEvents ?? []).reduce((n, e) => n + e.bytes, 0);
}
export function validateRenewalEvidence(s: State): void {
  const events = s.renewalEvents ?? [];
  if (!Array.isArray(events) || events.length > 8)
    throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
  for (const [i, e] of events.entries()) {
    if (
      i > 0 &&
      ((i % 4 !== 0 &&
        JSON.stringify(e.approval) !==
          JSON.stringify(events[Math.floor(i / 4) * 4].approval)) ||
        Date.parse(e.at) < Date.parse(events[i - 1].at))
    )
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    approveRenewal(e.approval, e.approval.id, Date.parse(e.at));
    if (
      (i < 4 ? e.approval.round !== undefined : e.approval.round !== 2) ||
      (i >= 4 && e.approval.id === events[0].approval.id) ||
      e.actor !== (i % 4 < 2 ? "A" : "B") ||
      e.operation !== (i % 2 === 0 ? "login" : "identity") ||
      !["reserved", "dispatched", "completed", "failed", "ambiguous"].includes(
        e.state,
      ) ||
      !Number.isSafeInteger(e.bytes) ||
      e.bytes < 0 ||
      (e.operation === "identity" && e.bytes !== 0) ||
      (e.operation === "login" && (e.bytes < 1 || e.bytes > 16384)) ||
      !e.previousSession?.verified ||
      (i < 4 &&
        e.operation === "login" &&
        !expiredOrdinarySession(
          e.previousSession.token,
          e.actor,
          Date.parse(e.at),
        )) ||
      (i > 0 && events[i - 1].state !== "completed") ||
      (i < events.length - 1 && e.state !== "completed")
    )
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    if (e.state === "completed") {
      if (
        e.status !== 200 ||
        !e.token ||
        !usableSession(e.token, e.actor, Date.parse(e.at), 60000)
      )
        throw new Error("SESSION_RENEWAL_IDENTITY_INVALID");
      if (e.operation === "identity") {
        const previous = events[i - 1];
        const u = e.identity;
        if (
          e.token !== previous.token ||
          JSON.stringify(e.previousSession) !==
            JSON.stringify(previous.previousSession) ||
          !u ||
          u.id !== USERS[e.actor].id ||
          u.email !== USERS[e.actor].email ||
          u.role !== "authenticated" ||
          u.is_anonymous !== false
        )
          throw new Error("SESSION_RENEWAL_IDENTITY_INVALID");
      }
    }
  }
  if (
    events.length &&
    (renewalBytes(s) > 32550 || s.bytes + renewalBytes(s) > 6325536)
  )
    throw new Error("SESSION_RENEWAL_BUDGET_EXHAUSTED");
}
export function validateSessionProgress(
  base: State,
  prior: State,
  s: State,
): void {
  validateRenewalEvidence(s);
  const before = prior.renewalEvents ?? [],
    after = s.renewalEvents ?? [];
  if (
    JSON.stringify(Object.keys(s.sessions).sort()) !==
    JSON.stringify(Object.keys(base.sessions).sort())
  )
    throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
  if (after.length < before.length || after.length > before.length + 1)
    throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
  for (const [i, e] of before.entries()) {
    const next = after[i];
    if (
      ["failed", "ambiguous"].includes(e.state) &&
      JSON.stringify(e) !== JSON.stringify(next)
    )
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    if (e.state === "dispatched" && next.state === "reserved")
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    if (e.state === "completed" && JSON.stringify(e) !== JSON.stringify(next))
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    if (e.state !== "completed") {
      const fixed = (x: RenewalEvent) => [
        x.actor,
        x.operation,
        x.at,
        x.bytes,
        x.approval,
        x.previousSession,
      ];
      if (JSON.stringify(fixed(e)) !== JSON.stringify(fixed(next)))
        throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    }
  }
  for (const actor of ["A", "B"] as const) {
    const identity = [...after]
      .reverse()
      .find(
        (e) =>
          e.actor === actor &&
          e.operation === "identity" &&
          e.state === "completed",
      );
    const expected = identity
      ? { token: identity.token, verified: true }
      : base.sessions[actor];
    if (JSON.stringify(s.sessions[actor]) !== JSON.stringify(expected))
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    const login = after.find(
      (e) => e.actor === actor && e.operation === "login",
    );
    if (
      login &&
      JSON.stringify(login.previousSession) !==
        JSON.stringify(base.sessions[actor])
    )
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
    const secondLogin = after
      .slice(4)
      .find((e) => e.actor === actor && e.operation === "login");
    const firstIdentity = after
      .slice(0, 4)
      .find(
        (e) =>
          e.actor === actor &&
          e.operation === "identity" &&
          e.state === "completed",
      );
    if (
      secondLogin &&
      (!firstIdentity ||
        JSON.stringify(secondLogin.previousSession) !==
          JSON.stringify({ token: firstIdentity.token, verified: true }))
    )
      throw new Error("SESSION_RENEWAL_HISTORY_INVALID");
  }
}
