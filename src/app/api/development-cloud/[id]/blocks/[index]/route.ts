import { z } from "zod";
import { developmentCloudRuntime } from "@/lib/backend/development-cloud.server";
import { apiError } from "@/lib/backend/api";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; index: string }> },
) {
  try {
    const params = await context.params;
    const cloud = await developmentCloudRuntime();
    const bytes = await cloud.download(
      z.uuid().parse(params.id),
      z.coerce.number().int().min(0).max(127).parse(params.index),
    );
    // The client rechunks this bounded response before decoding.
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
