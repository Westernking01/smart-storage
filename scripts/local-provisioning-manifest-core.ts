import { createClient } from "@supabase/supabase-js";
import {
  provisioningManifest,
  LOCAL_AUTH_ISSUER,
} from "../src/lib/backend/local-account-provisioning.server";

const provider = LOCAL_AUTH_ISSUER.replace(/\/auth\/v1$/, "");

function requirePublicKey(publicKey: string) {
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publicKey)) return;
  const parts = publicKey.split(".");
  const key = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString());
  if (
    parts.length !== 3 ||
    key.role !== "anon" ||
    key.ref !== "fneuqneqaopkmpeevlqz"
  )
    throw Error();
}

/** One password exchange followed by the existing one-request verifier. */
export function privateLoginManifestVerifier(transport: typeof fetch) {
  let used = false;
  return async (publicKey: string, email: string, password: string) => {
    if (used) throw Error("LOGIN_ALREADY_ATTEMPTED");
    used = true;
    try {
      requirePublicKey(publicKey);
      if (!email.trim() || !password) throw Error();
      let requests = 0;
      const client = createClient(provider, publicKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        global: {
          fetch: async (url, init) => {
            if (
              ++requests !== 1 ||
              String(url) !==
                `${LOCAL_AUTH_ISSUER}/token?grant_type=password` ||
              init?.method !== "POST"
            )
              throw Error();
            return transport(url, {
              ...init,
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            });
          },
        },
      });
      const { data, error } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      // Clear local credential references; JS strings cannot be securely zeroed.
      email = "";
      password = "";
      if (
        error ||
        !data.session?.access_token ||
        !data.user?.id ||
        requests !== 1
      )
        throw Error();
      const manifest = await privateManifestVerifier(transport)(
        publicKey,
        data.session.access_token,
      );
      if (manifest.subject !== data.user.id.toLowerCase()) throw Error();
      return manifest;
    } catch {
      throw Error("PRIVATE_LOGIN_VERIFICATION_FAILED");
    } finally {
      email = "";
      password = "";
    }
  };
}

/** Private, single-use verification only. No login, refresh, persistence or SQL. */
export function privateManifestVerifier(transport: typeof fetch) {
  let used = false;
  return async (publicKey: string, bearer: string) => {
    if (used) throw Error("VERIFICATION_ALREADY_ATTEMPTED");
    used = true;
    try {
      requirePublicKey(publicKey);
      const parts = bearer.split(".");
      if (
        bearer.length > 16384 ||
        parts.length !== 3 ||
        !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(bearer)
      )
        throw Error();
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      const expires = Number(claims.exp) * 1000;
      if (
        claims.iss !== LOCAL_AUTH_ISSUER ||
        claims.role !== "authenticated" ||
        claims.aud !== "authenticated" ||
        !Number.isSafeInteger(expires) ||
        expires <= Date.now()
      )
        throw Error();
      let requests = 0;
      const client = createClient(provider, publicKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        global: {
          fetch: async (url, init) => {
            // Fence SDK retries and every endpoint except one explicit getUser.
            if (
              ++requests !== 1 ||
              String(url) !== `${LOCAL_AUTH_ISSUER}/user` ||
              init?.method !== "GET"
            )
              throw Error();
            return transport(url, {
              ...init,
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            });
          },
        },
      });
      const manifest = await provisioningManifest(
        provider,
        {
          auth: { getUser: () => client.auth.getUser(bearer) },
        },
        { quotaBytes: "262144", maxSlots: 1 },
      );
      if (
        manifest.subject !== String(claims.sub).toLowerCase() ||
        expires <= Date.now() ||
        requests !== 1
      )
        throw Error();
      return manifest;
    } catch {
      // Never expose provider errors, tokens, keys or response bodies.
      throw Error("PRIVATE_IDENTITY_VERIFICATION_FAILED");
    }
  };
}
