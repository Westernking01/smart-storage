import { backendConfig, validMutationOrigin } from "@/lib/backend/config";
import { ownerContext, rpc } from "@/lib/backend/operations";
import { uuid } from "@/lib/backend/schemas";
import { apiError } from "@/lib/backend/api";
import { failure, response } from "@/lib/backend/http";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const config = backendConfig(process.env);
    if (!config) return failure("BACKEND_DISABLED", 503);
    if (!validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    return response(
      await rpc(
        await ownerContext(),
        "ss_cancel",
        { p_session: uuid.parse((await params).id) },
        (v) => v,
      ),
      202,
    );
  } catch (e) {
    return apiError(e);
  }
}
