import { ownerContext, rpc } from "@/lib/backend/operations";
import { sessionInput } from "@/lib/backend/schemas";
import { backendConfig, validMutationOrigin } from "@/lib/backend/config";
import { boundedJson, failure, response } from "@/lib/backend/http";
import { apiError } from "@/lib/backend/api";
export async function GET() {
  try {
    return response(
      await rpc(await ownerContext(), "ss_sessions", {}, (v) => v),
    );
  } catch (e) {
    return apiError(e);
  }
}
export async function POST(request: Request) {
  try {
    const config = backendConfig(process.env);
    if (!config) return failure("BACKEND_DISABLED", 503);
    if (!validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    const context = await ownerContext(),
      input = sessionInput.parse(await boundedJson(request));
    return response(
      await rpc(
        context,
        "ss_reserve",
        {
          p_key: input.idempotencyKey,
          p_name: input.metadata.originalName,
          p_mime: input.metadata.originalMime,
          p_original: input.originalBytes,
          p_hash: input.sourceSha256,
        },
        (v) => v,
      ),
      201,
    );
  } catch (e) {
    return apiError(e);
  }
}
