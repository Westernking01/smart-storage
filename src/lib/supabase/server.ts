import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { backendConfig } from "../backend/config";
import { ordinaryIdentity } from "../backend/identity";
export async function serverSupabase(writable = false) {
  const config = backendConfig(process.env);
  if (!config) throw Error("BACKEND_DISABLED");
  const jar = await cookies();
  return createServerClient(config.url, config.key, {
    cookieOptions: {
      path: "/",
      sameSite: "lax",
      secure: config.origin.startsWith("https:"),
    },
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (values) => {
        try {
          values.forEach(({ name, value, options }) =>
            jar.set(name, value, options),
          );
        } catch {
          if (writable) throw Error("COOKIE_WRITE_FAILED");
          /* Server components are read-only; proxy propagates refreshed cookies. */
        }
      },
    },
  });
}
export async function verifiedAccount() {
  const client = await serverSupabase();
  const { data, error } = await client.auth.getUser();
  const id = error ? null : ordinaryIdentity(data.user);
  if (!id) return null;
  return { id, client };
}
