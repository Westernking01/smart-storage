import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { backendConfig } from "./lib/backend/config";
import { ordinaryIdentity } from "./lib/backend/identity";
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  let config;
  try {
    config = backendConfig(process.env);
  } catch {
    return response;
  }
  if (!config) return response;
  // Recovery request pages and submissions do not need an existing session.
  // Avoid an unrelated Auth lookup before the reset request itself.
  if (
    request.nextUrl.pathname === "/forgot-password" ||
    request.nextUrl.pathname === "/api/auth/reset"
  )
    return response;
  const supabase = createServerClient(config.url, config.key, {
    cookieOptions: {
      path: "/",
      sameSite: "lax",
      secure: config.origin.startsWith("https:"),
    },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        values.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        response.headers.set("Cache-Control", "private, no-store");
      },
    },
  });
  const { data, error } = await supabase.auth.getUser();
  if (
    (request.nextUrl.pathname.startsWith("/app") ||
      request.nextUrl.pathname === "/account") &&
    (error || !ordinaryIdentity(data.user))
  ) {
    const next = new URL("/login", config.origin);
    next.searchParams.set("next", request.nextUrl.pathname);
    const redirect = NextResponse.redirect(next);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    redirect.headers.set("Cache-Control", "private, no-store");
    return redirect;
  }
  return response;
}
export const config = {
  matcher: [
    "/app/:path*",
    "/account",
    "/login",
    "/register",
    "/forgot-password",
    "/update-password",
    "/api/:path*",
    "/auth/:path*",
  ],
};
