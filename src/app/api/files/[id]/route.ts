import { ownerContext, getFile, rpc } from "@/lib/backend/operations";
import { ownedFile } from "@/lib/backend/files";
import { fileEdit, uuid } from "@/lib/backend/schemas";
import { backendConfig, validMutationOrigin } from "@/lib/backend/config";
import { boundedJson, failure, response } from "@/lib/backend/http";
import { apiError } from "@/lib/backend/api";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    return response(
      await getFile(await ownerContext(), uuid.parse((await params).id)),
    );
  } catch (e) {
    return apiError(e);
  }
}
async function mutate(request: Request, { params }: Context, remove: boolean) {
  try {
    const config = backendConfig(process.env);
    if (!config) return failure("BACKEND_DISABLED", 503);
    if (!validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    const context = await ownerContext(),
      id = uuid.parse((await params).id);
    if (remove)
      return response(
        await rpc(context, "ss_delete_file", { p_id: id }, (v) => v),
        202,
      );
    const input = fileEdit.parse(await boundedJson(request));
    return response(
      await rpc(
        context,
        "ss_edit_file",
        {
          p_id: id,
          p_name: input.displayName,
          p_category: input.category,
          p_revision: input.revision,
        },
        (v) => ownedFile.parse(v),
      ),
    );
  } catch (e) {
    return apiError(e);
  }
}
export const PATCH = (r: Request, c: Context) => mutate(r, c, false);
export const DELETE = (r: Request, c: Context) => mutate(r, c, true);
