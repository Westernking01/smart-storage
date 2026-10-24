import { NextResponse } from "next/server";
import { backendConfig, safeNext } from "@/lib/backend/config";
import { serverSupabase } from "@/lib/supabase/server";
import { ordinaryIdentity } from "@/lib/backend/identity";
export async function GET(request: Request) {
  let destination = "/login?error=confirmation";
  let origin = new URL(request.url).origin;
  try {
    const config = backendConfig(process.env);
    if (!config)
      return new Response("Backend setup is required.", {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    origin = config.origin;
    const query = new URL(request.url).searchParams;
    const code = query.get("code"),
      hash = query.get("token_hash"),
      type = query.get("type");
    const client = await serverSupabase(true);
    let error;
    if (code && code.length <= 2048 && !hash)
      ({ error } = await client.auth.exchangeCodeForSession(code));
    else if (
      hash &&
      /^[a-f0-9]{32,128}$/.test(hash) &&
      ["email", "recovery"].includes(type ?? "") &&
      !code
    )
      ({ error } = await client.auth.verifyOtp({
        token_hash: hash,
        type: type as "email" | "recovery",
      }));
    else throw Error("INVALID_CALLBACK");
    if (error) throw Error("INVALID_CALLBACK");
    const verified = await client.auth.getUser();
    if (verified.error || !ordinaryIdentity(verified.data.user))
      throw Error("INVALID_CALLBACK");
    destination =
      type === "recovery" ? "/update-password" : safeNext(query.get("next"));
  } catch {
    /* Never echo callback parameters or provider errors. */
  }
  const result = NextResponse.redirect(new URL(destination, origin));
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
}
