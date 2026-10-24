import type { VerifiedDisposableSession } from "./disposable-roundtrip-executor";
import { disposableUploadTarget as target } from "./disposable-upload-contract";

const origin = "https://rrylhvqalsxjnkdkpwde.supabase.co";
const issuer = `${origin}/auth/v1`;

function claims(token: string): Record<string, unknown> {
  if (token.length > 16384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
    throw Error("INVALID_TOKEN");
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

/** Lazy, single-use callback for runOperatorRoundTrip. Credentials must come
 * from private in-process input, never argv, files, environment or logging.
 * No persistence, refresh, redirects, retries or implicit application client.
 * Auth /user verifies the bearer remotely; decoding alone is not verification.
 */
export function ordinarySessionBridge(input: {
  publicUrl: string;
  publicKey: string;
  credentials: () => Promise<{ email: string; password: string }>;
  transport: typeof fetch;
  now?: () => number;
}): () => Promise<VerifiedDisposableSession> {
  let used = false;
  return async () => {
    if (used) throw Error("ORDINARY_AUTH_ALREADY_ATTEMPTED");
    used = true;
    try {
      if (input.publicUrl !== origin) throw Error("INVALID_PROJECT");
      const key = input.publicKey;
      if (
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) &&
        !(claims(key).role === "anon" && claims(key).ref === target.project)
      )
        throw Error("PUBLIC_KEY_REQUIRED");
      const now = input.now ?? Date.now;
      const exchange = async (path: string, token: string, body?: string) => {
        const response = await input.transport(`${issuer}/${path}`, {
          method: body ? "POST" : "GET",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            apikey: key,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body } : {}),
        });
        if (!response.ok) throw Error("AUTH_FAILED");
        return response.json();
      };
      let credentials: { email: string; password: string } | undefined;
      let session;
      try {
        credentials = await input.credentials();
        if (!credentials.email || !credentials.password)
          throw Error("MISSING_CREDENTIALS");
        session = await exchange(
          "token?grant_type=password",
          key,
          JSON.stringify(credentials),
        );
      } finally {
        credentials = undefined;
      }
      const token = session.access_token;
      const decoded = claims(token);
      const expiresAt = Number(decoded.exp) * 1000;
      if (
        session.user?.id !== target.userId ||
        decoded.sub !== target.userId ||
        decoded.role !== "authenticated" ||
        decoded.iss !== issuer ||
        decoded.aud !== "authenticated" ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now() ||
        session.token_type !== "bearer"
      )
        throw Error("INVALID_ORDINARY_IDENTITY");
      const user = await exchange("user", token);
      if (
        user.id !== target.userId ||
        user.role !== "authenticated" ||
        expiresAt <= now()
      )
        throw Error("INVALID_VERIFIED_IDENTITY");
      return {
        source: "external-verified-ordinary-session",
        userId: target.userId,
        issuer,
        role: "authenticated",
        accessToken: token,
        expiresAt,
      };
    } catch {
      // Never propagate provider bodies, thrown credential errors or tokens.
      throw Error("ORDINARY_AUTH_FAILED");
    }
  };
}
