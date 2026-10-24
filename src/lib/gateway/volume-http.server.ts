import "server-only";
import { z } from "zod";
import { ownerContext } from "../backend/operations";
import { backendConfig, validMutationOrigin } from "../backend/config";
import { boundedJson, failure, response } from "../backend/http";
import { apiError } from "../backend/api";
import { volumeRuntime } from "./volume-runtime.server";

const requestInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("begin"),
      key: z.string(),
      metadata: z.unknown(),
      manifest: z.unknown(),
    })
    .strict(),
  z.object({ action: z.literal("publish"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("cancel"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("delete"), id: z.uuid() }).strict(),
]);
export async function volumeGet(request: Request) {
  try {
    const owner = await ownerContext(),
      runtime = await volumeRuntime();
    const url = new URL(request.url),
      id = url.searchParams.get("id");
    if (!id)
      return response({
        files: await runtime.list(owner.id),
        account: await runtime.account(owner.id),
      });
    return response(
      await runtime.status(
        owner.id,
        z.uuid().parse(id),
        url.searchParams.get("ready") === "true" ? "read" : "status",
      ),
    );
  } catch (error) {
    return volumeError(error);
  }
}
export async function volumePost(request: Request) {
  try {
    const config = backendConfig(process.env);
    if (!config || !validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    const owner = await ownerContext(),
      runtime = await volumeRuntime();
    const input = requestInput.parse(await boundedJson(request, 132 * 1024));
    if (input.action === "begin") {
      const { action: _, ...body } = input;
      void _;
      return response(await runtime.begin(owner.id, body), 201);
    }
    return response(
      input.action === "publish"
        ? await runtime.publish(owner.id, input.id)
        : input.action === "delete"
          ? await runtime.delete(owner.id, input.id)
          : await runtime.cancel(owner.id, input.id),
    );
  } catch (error) {
    return volumeError(error);
  }
}
/** Rechunk the network stream; never allocate the entire encoded file/block. */
async function* body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return;
      for (let offset = 0; offset < value.length; offset += 65536)
        yield value.subarray(offset, offset + 65536);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function volumeBlock(
  request: Request,
  id: string,
  rawIndex: string,
) {
  try {
    z.uuid().parse(id);
    const index = z.coerce.number().int().min(0).max(127).parse(rawIndex);
    if (request.method === "PUT") {
      const config = backendConfig(process.env);
      if (!config || !validMutationOrigin(request.headers, config.origin))
        return failure("ORIGIN_DENIED", 403);
      if (request.headers.get("content-type") !== "application/octet-stream")
        return failure("INVALID_INPUT", 422);
    }
    const owner = await ownerContext(),
      runtime = await volumeRuntime();
    if (request.method === "PUT")
      return response(
        await runtime.upload(
          owner.id,
          id,
          index,
          body(request),
          request.signal,
        ),
      );
    const download = await runtime.download(owner.id, id, index);
    const iterator = download.source[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch {
          controller.error(Error("DOWNLOAD_FAILED"));
          await iterator.return?.();
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(download.bytes),
        "Content-Disposition": "attachment",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return volumeError(error);
  }
}
export function volumeError(error: unknown) {
  const codes: Record<string, number> = {
    LOCAL_VOLUME_DISABLED: 503,
    LOCAL_VOLUME_CONFIGURATION_INVALID: 503,
    VOLUME_MISMATCH: 503,
    QUOTA_EXCEEDED: 409,
    SLOTS_EXCEEDED: 409,
    ACCOUNT_SETUP_REQUIRED: 409,
    SESSION_BLOCKED: 409,
    REPLAY_DENIED: 409,
    ATTEMPT_AMBIGUOUS: 409,
    WRITER_TERMINATION_UNPROVEN: 409,
    READERS_ACTIVE: 409,
    REMOVAL_IN_PROGRESS: 409,
    FINALIZATION_BLOCKED: 409,
    CLEANUP_PROOF_REQUIRED: 409,
    NOT_FOUND: 404,
    STREAM_TOO_LARGE: 413,
    STREAM_TRUNCATED: 422,
    WRITER_FAILED: 422,
    INVALID_MANIFEST: 422,
    INVALID_BLOCK: 422,
    FILE_METADATA_INVALID: 422,
    MANIFEST_LIMIT: 413,
    IDEMPOTENCY_CONFLICT: 409,
    ALREADY_COMPLETED_USE_DELETE: 409,
  };
  if (error instanceof Error && Object.hasOwn(codes, error.message))
    return failure(error.message, codes[error.message]);
  return apiError(error);
}
