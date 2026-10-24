import "server-only";
import { redirect } from "next/navigation";
import { verifiedAccount } from "../supabase/server";
import { account, ownedFile, nextCursor, type OwnedFile } from "./files";
export class BackendError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export async function ownerContext() {
  const identity = await verifiedAccount();
  if (!identity) throw new BackendError("UNAUTHENTICATED", 401);
  return identity;
}
export async function pageAccount() {
  try {
    return await ownerContext();
  } catch {
    redirect("/login?next=/app");
  }
}
export async function rpc<T>(
  context: Awaited<ReturnType<typeof ownerContext>>,
  name: string,
  args: Record<string, unknown>,
  parse: (v: unknown) => T,
): Promise<T> {
  const { data, error } = await context.client.rpc(name, args);
  if (error) {
    const known: Record<string, number> = {
      NOT_FOUND: 404,
      REVISION_CONFLICT: 409,
      IDEMPOTENCY_CONFLICT: 409,
      QUOTA_EXCEEDED: 409,
      SLOTS_EXCEEDED: 409,
      ACCOUNT_SETUP_REQUIRED: 409,
      SESSION_EXPIRED_OR_BLOCKED: 409,
      INVALID_INPUT: 422,
      UNAUTHENTICATED: 401,
    };
    const code = Object.hasOwn(known, error.message)
      ? error.message
      : "BACKEND_OPERATION_FAILED";
    throw new BackendError(code, known[code] ?? 503);
  }
  return parse(data);
}
export const currentAccount = (
  context: Awaited<ReturnType<typeof ownerContext>>,
) =>
  rpc(context, "ss_account", {}, (v) => {
    const result = account.parse(v);
    if (result.id !== context.id)
      throw new BackendError("BACKEND_RESPONSE_INVALID", 503);
    return result;
  });
export async function listFiles(
  context: Awaited<ReturnType<typeof ownerContext>>,
  limit = 25,
  cursor?: { at: string; id: string } | null,
) {
  const files = await rpc(
    context,
    "ss_list_files",
    { p_limit: limit, p_before: cursor?.at ?? null, p_id: cursor?.id ?? null },
    (v) => ownedFile.array().max(50).parse(v),
  );
  if (files.some((f) => f.state !== "ready"))
    throw new BackendError("BACKEND_RESPONSE_INVALID", 503);
  return {
    files,
    next: files.length === limit ? nextCursor(files[files.length - 1]) : null,
  };
}
export const getFile = (
  context: Awaited<ReturnType<typeof ownerContext>>,
  id: string,
): Promise<OwnedFile> =>
  rpc(context, "ss_file", { p_id: id }, (v) => ownedFile.parse(v));
