import { ZodError } from "zod";
import { BackendError } from "./operations";
import { failure } from "./http";
export function apiError(e: unknown) {
  if (e instanceof BackendError) return failure(e.code, e.status);
  if (
    e instanceof ZodError ||
    e instanceof SyntaxError ||
    (e instanceof Error && e.message === "INVALID_INPUT")
  )
    return failure("INVALID_INPUT", 422);
  if (e instanceof Error && e.message === "BODY_LIMIT")
    return failure("BODY_LIMIT", 413);
  if (e instanceof Error && e.message === "BACKEND_DISABLED")
    return failure("BACKEND_DISABLED", 503);
  return failure("REQUEST_FAILED", 503);
}
