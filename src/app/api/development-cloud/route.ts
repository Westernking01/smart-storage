import { z } from "zod";
import { developmentCloudRuntime } from "@/lib/backend/development-cloud.server";
import { developmentCloudConfig } from "@/lib/backend/development-cloud-config";
import { validMutationOrigin } from "@/lib/backend/config";
import { boundedJson, failure, response } from "@/lib/backend/http";
import { apiError } from "@/lib/backend/api";
export const runtime = "nodejs";
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), checkpoint: z.unknown() }).strict(),
  z
    .object({
      action: z.literal("verify"),
      id: z.uuid(),
      index: z.number().int().min(0).max(127),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish"),
      id: z.uuid(),
      manifest: z.unknown(),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const cloud = await developmentCloudRuntime();
    const id = new URL(request.url).searchParams.get("id");
    const key = new URL(request.url).searchParams.get("key");
    return response(
      key
        ? await cloud.receipt(
            z.uuid().parse(key),
            z.uuid().parse(new URL(request.url).searchParams.get("owner")),
          )
        : id
          ? { manifest: await cloud.ready(z.uuid().parse(id)) }
          : await cloud.listing(),
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    const config = developmentCloudConfig(process.env);
    if (!config) return failure("DEV_CLOUD_DISABLED", 503);
    if (!validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    const input = command.parse(await boundedJson(request, 256 * 1024));
    const cloud = await developmentCloudRuntime();
    return response(
      input.action === "begin"
        ? await cloud.begin(input.checkpoint)
        : input.action === "verify"
          ? await cloud.verify(input.id, input.index)
          : await cloud.publish(input.id, input.manifest),
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function PUT(request: Request) {
  try {
    const config = developmentCloudConfig(process.env);
    if (!config) return failure("DEV_CLOUD_DISABLED", 503);
    if (!validMutationOrigin(request.headers, config.origin))
      return failure("ORIGIN_DENIED", 403);
    if (
      request.headers.get("content-type") !== "application/octet-stream" ||
      !request.body
    )
      return failure("INVALID_INPUT", 422);
    const params = new URL(request.url).searchParams;
    const id = z.uuid().parse(params.get("id")),
      requestId = z.uuid().parse(params.get("request"));
    const index = z.coerce
      .number()
      .int()
      .min(0)
      .max(127)
      .parse(params.get("index"));
    const cloud = await developmentCloudRuntime();
    const reader = request.body.getReader(),
      body = new Uint8Array(config.maximumBytes);
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (size + value.length > body.length)
          return failure("BODY_LIMIT", 413);
        body.set(value, size);
        size += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return response(
      await cloud.write(
        id,
        index,
        requestId,
        body.slice(0, size),
        request.headers.get("x-cloud-permit") ?? "",
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
