import { NextResponse } from "next/server";
export function response(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export function failure(code: string, status: number) {
  return response({ error: { code, requestId: crypto.randomUUID() } }, status);
}
export async function boundedJson(
  request: Request,
  limit = 16 * 1024,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
    !request.body
  )
    throw Error("INVALID_INPUT");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > limit) throw Error("BODY_LIMIT");
      bytes.set(value, size);
      size += value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
