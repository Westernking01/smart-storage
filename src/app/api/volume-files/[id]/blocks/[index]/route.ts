import { volumeBlock } from "@/lib/gateway/volume-http.server";
export const runtime = "nodejs";
async function handle(
  request: Request,
  context: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await context.params;
  return volumeBlock(request, id, index);
}
export const PUT = handle;
export const GET = handle;
