import { listFiles, ownerContext } from "@/lib/backend/operations";
import { pageInput } from "@/lib/backend/schemas";
import { readCursor } from "@/lib/backend/files";
import { response } from "@/lib/backend/http";
import { apiError } from "@/lib/backend/api";
export async function GET(request: Request) {
  try {
    const context = await ownerContext();
    const input = pageInput.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return response(
      await listFiles(context, input.limit, readCursor(input.cursor)),
    );
  } catch (e) {
    return apiError(e);
  }
}
