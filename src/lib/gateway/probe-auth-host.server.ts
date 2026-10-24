import "server-only";
import { z } from "zod";
import { createBoundedProbeAuthHttp } from "./bounded-probe-http.server";
import {
  preflightProbeAuthentication,
  preflightSeededFixtureAuthentication,
} from "./probe-auth-preflight.server";
import { preflightDisposableProbe } from "./disposable-probe-preflight.server";
import { FileProbeFence } from "./probe-fence.server";
import {
  ReadOnlyInspectionRunner,
  type InspectionTarget,
} from "./inspection-runner.server";
import type { InspectionSink } from "./inspection-evidence.server";
import type { HttpFetch } from "./supabase-storage-transport.server";
import { win32 } from "node:path";
import type { SeededFixture } from "./seeded-fixture-contract";

const endpoint = "https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1";
const uid = "310d0ec8-84ca-423a-b646-0480a20edc09";
export const probeAuthAuthorizationSchema = z
  .object({
    enabled: z.literal(true),
    authorizationId: z.uuid(),
    project: z.literal("rrylhvqalsxjnkdkpwde"),
    authEndpoint: z.literal(endpoint),
    userId: z.literal(uid),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operations: z
      .object({
        passwordSignIn: z.literal(1),
        identityVerification: z.literal(1),
      })
      .strict(),
    maximumResponseBodyBytesPerOperation: z.literal(65536),
    timeoutMs: z.literal(30000),
    retries: z.literal(0),
    redirects: z.literal(0),
    accounting: z.literal("accepted-raw-response-body"),
    physicalOverheadUnboundedAcknowledged: z.literal(true),
    evidenceDirectory: z
      .string()
      .min(1)
      .refine(
        (v) =>
          win32.isAbsolute(v) && !v.startsWith("\\\\") && !v.includes(".."),
      ),
    restrictedAclReviewed: z.literal(true),
  })
  .strict();

type AuthApproval = z.infer<typeof probeAuthAuthorizationSchema>;
function current(a: AuthApproval, now: number) {
  if (
    !Number.isSafeInteger(now) ||
    a.issuedAt > now ||
    a.expiresAt <= now ||
    a.expiresAt <= a.issuedAt ||
    a.expiresAt - a.issuedAt > 1800000
  )
    throw Error("AUTH_UNAUTHORIZED");
}

/** Pure local gate; call before constructing credential readers or connections. */
export function preflightProbeAuthHost(
  plan: unknown,
  review: unknown,
  approval: unknown,
  now = Date.now(),
) {
  return preflightAuthWithReview(
    plan,
    review,
    approval,
    now,
    preflightProbeAuthentication,
  );
}

export function preflightSeededFixtureAuthHost(
  plan: unknown,
  review: unknown,
  approval: unknown,
  now = Date.now(),
) {
  return preflightAuthWithReview(
    plan,
    review,
    approval,
    now,
    preflightSeededFixtureAuthentication,
  );
}

function preflightAuthWithReview(
  plan: unknown,
  review: unknown,
  approval: unknown,
  now: number,
  reviewPreflight: typeof preflightProbeAuthentication,
) {
  reviewPreflight(plan, review);
  const a = probeAuthAuthorizationSchema.parse(approval);
  current(a, now);
  return a;
}

function claims(token: string, now: number) {
  // Decoding is a sanity check only. The separate authenticated /user response
  // establishes identity; no locally decoded JWT is treated as verified alone.
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16384)
    throw Error("AUTH_IDENTITY_REJECTED");
  const c = z
    .object({
      iss: z.literal(endpoint),
      sub: z.literal(uid),
      role: z.literal("authenticated"),
      aud: z.literal("authenticated"),
      exp: z.number().int().positive(),
    })
    .parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  if (c.exp * 1000 - now < 120000) throw Error("AUTH_SESSION_EXPIRED");
  return c.exp * 1000;
}

type Input = { apiKey: string; email: string; password: string };
type ProbeOptions = {
  config: unknown;
  authorization: unknown;
  target: InspectionTarget;
  destinations: unknown;
  sink: InspectionSink;
  resolveSeeded?: () => Promise<SeededFixture>;
  fence: { claim(id: string, kind: string): Promise<void> };
};

/** No SDK session store, refresh timer, environment fallback, public route or logs.
 * Both allowed operations are consumed together before secret acquisition.
 * A failed/ambiguous request never retries. Only fixed, redacted errors escape. */
type AuthHostOptions = {
  plan: unknown;
  review: unknown;
  authorization: unknown;
  readMaskedCredentials: () => Promise<Input>;
  confirm: (authorizationId: string) => Promise<boolean>;
  http?: HttpFetch;
  probeHttp?: HttpFetch;
  fence?: { claim(id: string, kind: string): Promise<void> };
  now?: () => number;
};

export function authenticateProbeHost(options: AuthHostOptions) {
  return authenticateWithReview(options, preflightProbeAuthHost);
}

/** Seeded workflow only; the same approval and execution controls still apply. */
export function authenticateSeededFixtureHost(options: AuthHostOptions) {
  return authenticateWithReview(options, preflightSeededFixtureAuthHost);
}

async function authenticateWithReview(
  options: AuthHostOptions,
  preflight: typeof preflightProbeAuthHost,
) {
  const now = options.now ?? Date.now;
  let secret: Input | undefined;
  let bearer = "";
  let apiKey = "";
  try {
    const a = preflight(
      options.plan,
      options.review,
      options.authorization,
      now(),
    );
    if (!(await options.confirm(a.authorizationId)))
      throw Error("AUTH_CANCELLED");
    current(a, now());
    await (options.fence ?? new FileProbeFence(a.evidenceDirectory)).claim(
      a.authorizationId,
      "auth-password-and-identity",
    );
    current(a, now());
    secret = await options.readMaskedCredentials();
    if (
      !/^sb_publishable_[A-Za-z0-9_-]{8,512}$/.test(secret.apiKey) ||
      !secret.email ||
      !secret.password ||
      secret.email.length > 320 ||
      secret.password.length > 1024
    )
      throw Error("AUTH_INPUT_REJECTED");
    apiKey = secret.apiKey;
    const http = options.http ?? createBoundedProbeAuthHttp();
    const request = async (path: string, init: RequestInit) => {
      current(a, now());
      const response = await http(endpoint + path, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error("AUTH_REQUEST_REJECTED");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 65536) throw Error("AUTH_BODY_LIMIT");
      current(a, now());
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    };
    let signed: unknown;
    try {
      signed = await request("/token?grant_type=password", {
        method: "POST",
        headers: { apikey: apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          email: secret.email,
          password: secret.password,
        }),
      });
    } finally {
      secret = undefined;
    }
    // Ignore refresh_token entirely; never retain the response/session object.
    bearer = z
      .object({
        access_token: z.string().min(1),
        token_type: z.literal("bearer"),
        user: z.object({ id: z.literal(uid) }),
      })
      .parse(signed).access_token;
    signed = undefined;
    const started = now();
    const expiry = claims(bearer, started);
    const identity = await request("/user", {
      method: "GET",
      headers: { apikey: apiKey, authorization: `Bearer ${bearer}` },
    });
    z.object({ id: z.literal(uid), role: z.literal("authenticated") }).parse(
      identity,
    );
    const useUntil = Math.min(expiry, a.expiresAt, started + 1800000);
    const credentials = async () => {
      if (!bearer || now() >= useUntil) throw Error("AUTH_SESSION_EXPIRED");
      claims(bearer, now());
      return { bearer, apiKey };
    };
    await credentials();
    const disposal = setTimeout(
      () => {
        bearer = "";
        apiKey = "";
      },
      Math.max(0, useUntil - now()),
    );
    disposal.unref();
    return {
      userId: uid,
      expiresAt: useUntil,
      dispose() {
        clearTimeout(disposal);
        bearer = "";
        apiKey = "";
      },
      async runProbe(
        p: ProbeOptions,
        kind: "metadata" | "hash" | "list",
        operationId: string,
        signal: AbortSignal,
      ) {
        const authorization = preflightDisposableProbe(
          p.config,
          p.authorization,
          p.target,
          p.destinations,
          kind,
          now(),
        );
        await credentials();
        // Storage remains separately disabled/authorized. Durable runner fencing,
        // observer evidence and all provisional/retain-holds semantics are reused.
        return new ReadOnlyInspectionRunner({
          enabled: true,
          target: authorization.target,
          authorization,
          credentials,
          fetch: options.probeHttp,
          sink: p.sink,
          resolveSeeded: p.resolveSeeded,
          fence: p.fence,
        }).run(kind, operationId, signal);
      },
    };
  } catch {
    bearer = "";
    apiKey = "";
    throw Error("PROBE_AUTH_FAILED_CLOSED");
  } finally {
    secret = undefined;
  }
}
