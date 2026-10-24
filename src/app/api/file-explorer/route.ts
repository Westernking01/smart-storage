import { ownerContext, BackendError } from "@/lib/backend/operations";
import { backendConfig, validMutationOrigin } from "@/lib/backend/config";
import { boundedJson, failure, response } from "@/lib/backend/http";
import { apiError } from "@/lib/backend/api";
import {
  explorerQuery,
  explorerCommand,
  explorerListing,
  folderRecord,
  moveReceipt,
} from "@/lib/backend/explorer-contract";
async function call(
  context: Awaited<ReturnType<typeof ownerContext>>,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await context.client.rpc(name, args);
  if (result.error) {
    if (["PGRST202", "42883"].includes(result.error.code ?? ""))
      throw new BackendError("FOLDER_BACKEND_UNAVAILABLE", 503);
    const code = result.error.message;
    if (
      [
        "NOT_FOUND",
        "REVISION_CONFLICT",
        "INVALID_INPUT",
        "FOLDER_LIMIT",
      ].includes(code)
    )
      throw new BackendError(code, code === "NOT_FOUND" ? 404 : 409);
    throw new BackendError("EXPLORER_OPERATION_FAILED", 503);
  }
  return result.data;
}
export async function GET(request: Request) {
  try {
    const input = explorerQuery.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const context = await ownerContext();
    return response(
      explorerListing.parse(
        await call(context, "ss_explorer_list", {
          p_parent: input.folder ?? null,
          p_query: input.query,
          p_sort: input.sort,
          p_offset: input.offset,
        }),
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    const config = backendConfig(process.env);
    if (!config) return failure("BACKEND_DISABLED", 503);
    if (!validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    const input = explorerCommand.parse(await boundedJson(request, 4096));
    const context = await ownerContext();
    if (input.action === "create")
      return response(
        folderRecord.parse(
          await call(context, "ss_folder_create", {
            p_id: input.id,
            p_parent: input.parent,
            p_name: input.name,
          }),
        ),
      );
    if (input.action === "rename")
      return response(
        folderRecord.parse(
          await call(context, "ss_folder_rename", {
            p_id: input.id,
            p_name: input.name,
            p_revision: input.revision,
          }),
        ),
      );
    const value = await call(context, "ss_file_move", {
      p_file: input.id,
      p_folder: input.folder,
      p_revision: input.revision,
    });
    const receipt = moveReceipt.parse(value);
    if (receipt.id !== input.id || receipt.folderId !== input.folder)
      throw new BackendError("EXPLORER_OPERATION_FAILED", 503);
    return response(receipt);
  } catch (error) {
    return apiError(error);
  }
}
