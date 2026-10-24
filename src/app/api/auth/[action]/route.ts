import { createHash } from "node:crypto";
import {
  backendConfig,
  safeNext,
  validMutationOrigin,
} from "@/lib/backend/config";
import { authInput } from "@/lib/backend/schemas";
import { AuthLimiter } from "@/lib/backend/rate-limit";
import { boundedJson, failure, response } from "@/lib/backend/http";
import { serverSupabase } from "@/lib/supabase/server";
import { ordinaryIdentity } from "@/lib/backend/identity";
const limiter = new AuthLimiter();
export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  try {
    const config = backendConfig(process.env);
    if (!config) return failure("BACKEND_DISABLED", 503);
    if (!validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    const { action } = await params;
    if (!Object.hasOwn(authInput, action)) return failure("NOT_FOUND", 404);
    const body = authInput[action as keyof typeof authInput].safeParse(
      await boundedJson(request),
    );
    if (!body.success) return failure("INVALID_INPUT", 422);
    const input = body.data as {
      email?: string;
      password?: string;
      next?: string;
    };
    const subject = createHash("sha256")
      .update(`${action}:${input.email?.toLowerCase() ?? "session"}`)
      .digest("hex");
    if (!limiter.allow(subject)) return failure("RATE_LIMITED", 429);
    const client = await serverSupabase(true);
    if (action === "logout") {
      const { error } = await client.auth.signOut({ scope: "local" });
      return error
        ? failure("SIGN_OUT_FAILED", 503)
        : response({ next: "/login" });
    }
    if (action === "reset") {
      // Same result for registered and unknown addresses; never relay provider messages.
      const reset = await client.auth.resetPasswordForEmail(input.email!, {
        redirectTo: `${config.origin}/auth/callback?next=/update-password`,
      });
      if (reset.error) return failure("RESET_REQUEST_FAILED", 503);
      return response({
        message:
          "If this address can receive recovery mail, instructions will arrive shortly.",
      });
    }
    if (action === "update") {
      const { data, error } = await client.auth.getUser();
      if (error || !ordinaryIdentity(data.user))
        return failure("UNAUTHENTICATED", 401);
      const updated = await client.auth.updateUser({
        password: input.password!,
      });
      return updated.error
        ? failure("PASSWORD_UPDATE_FAILED", 422)
        : response({ message: "Password updated.", next: "/app" });
    }
    if (action === "register") {
      const registered = await client.auth.signUp({
        email: input.email!,
        password: input.password!,
        options: { emailRedirectTo: `${config.origin}/auth/callback` },
      });
      if (registered.error && registered.error.code !== "user_already_exists")
        return failure("REGISTRATION_FAILED", 422);
      if (registered.data.session) {
        const verified = await client.auth.getUser();
        if (!verified.error && ordinaryIdentity(verified.data.user))
          return response({ next: "/app" });
      }
      // A generic result also covers duplicate registration; confirmation is not fabricated.
      return response({
        message:
          "Check your email for confirmation instructions. If already registered, sign in or reset your password.",
      });
    }
    const result = await client.auth.signInWithPassword({
      email: input.email!,
      password: input.password!,
    });
    if (result.error) return failure("SIGN_IN_FAILED", 401);
    const verified = await client.auth.getUser();
    if (verified.error || !ordinaryIdentity(verified.data.user)) {
      await client.auth.signOut({ scope: "local" });
      return failure("SIGN_IN_FAILED", 401);
    }
    return response({ next: safeNext(input.next) });
  } catch (e) {
    if (e instanceof Error && e.message === "BODY_LIMIT")
      return failure("BODY_LIMIT", 413);
    if (
      e instanceof SyntaxError ||
      (e instanceof Error && e.message === "INVALID_INPUT")
    )
      return failure("INVALID_INPUT", 422);
    return failure("REQUEST_FAILED", 503);
  }
}
