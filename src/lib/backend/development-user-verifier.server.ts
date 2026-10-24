import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ordinaryIdentity } from "./identity";

const issuer = "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1";
type Auth = Pick<
  SupabaseClient["auth"],
  "getSession" | "getUser" | "getClaims"
>;

/** Supply only the server-created client for the pinned development project.
 * Session data supplies a candidate token, never authoritative identity.
 * No Storage access, publisher claims, token output or cached verification. */
export async function developmentUserVerifier(auth: Auth) {
  const check = async (): Promise<string> => {
    try {
      const session = await auth.getSession();
      const token = session.data.session?.access_token;
      if (
        session.error ||
        typeof token !== "string" ||
        token.length > 16384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw Error();
      // Explicit token prevents implicit refresh from verifying a different session.
      const user = await auth.getUser(token);
      const id = user.error ? null : ordinaryIdentity(user.data.user);
      if (!id) throw Error();
      const result = await auth.getClaims(token);
      const claims = result.data?.claims;
      if (
        result.error ||
        !claims ||
        claims.iss !== issuer ||
        claims.sub !== id ||
        claims.role !== "authenticated" ||
        claims.is_anonymous !== false ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= Date.now() / 1000
      )
        throw Error();
      return id;
    } catch {
      // Provider exceptions may contain credentials or request diagnostics.
      throw Error("DEV_USER_VERIFICATION_FAILED");
    }
  };
  const id = await check();
  return {
    id,
    /** Compatible with postgresPublisher's verify callback; call after checkout.
     * Bound to the first verified identity, never a caller-supplied subject. */
    verify: async (): Promise<string> => {
      const current = await check();
      if (current !== id) throw Error("DEV_USER_VERIFICATION_FAILED");
      return current;
    },
  };
}
