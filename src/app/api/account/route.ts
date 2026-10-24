import { backendConfig, validMutationOrigin } from "@/lib/backend/config";
import { currentAccount, ownerContext, rpc } from "@/lib/backend/operations";
import { apiError } from "@/lib/backend/api";
import { boundedJson, failure, response } from "@/lib/backend/http";
import { z } from "zod";
export async function GET() {
  try {
    return response(await currentAccount(await ownerContext()));
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
    z.object({})
      .strict()
      .parse(await boundedJson(request));
    const context = await ownerContext();
    await rpc(context, "ss_bootstrap", {}, (v) => v);
    return response(await currentAccount(context));
  } catch (e) {
    return apiError(e);
  }
}
