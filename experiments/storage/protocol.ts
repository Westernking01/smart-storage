/** Local protocol probe only. This is not a production upload client. */
export const TRANSPORT_BYTES = 6 * 1024 * 1024;
export const LOGICAL_BYTES = 8 * 1024 * 1024;

export function byteCount(value: string | null): number {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Missing or invalid byte count");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Unsafe byte count");
  return parsed;
}

export function chunks(length: number, size = TRANSPORT_BYTES): number[] {
  if (!Number.isSafeInteger(length) || length < 0 || length > LOGICAL_BYTES) {
    throw new Error("Probe length exceeds bounded fixture envelope");
  }
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error("Invalid chunk");
  const result: number[] = [];
  for (let offset = 0; offset < length; offset += size) {
    result.push(Math.min(size, length - offset));
  }
  return result;
}

export function localResource(location: string, endpoint: string): URL {
  const base = new URL(endpoint);
  const resource = new URL(location, base);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    resource.origin !== base.origin ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash
  ) {
    throw new Error("Only same-origin loopback model resources are permitted");
  }
  return resource;
}

export async function confirmedOffset(
  resource: URL,
  length: number,
): Promise<number> {
  localResource(resource.href, resource.href);
  const response = await fetch(resource, {
    method: "HEAD",
    headers: { "Tus-Resumable": "1.0.0" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HEAD status ${response.status}`);
  if (response.headers.get("Tus-Resumable") !== "1.0.0") {
    throw new Error("Unexpected protocol version");
  }
  const offset = byteCount(response.headers.get("Upload-Offset"));
  const reportedLength = byteCount(response.headers.get("Upload-Length"));
  if (reportedLength !== length || offset > length)
    throw new Error("Offset/length mismatch");
  return offset;
}

export async function resumeLocal(
  resource: URL,
  encoded: Uint8Array,
  size = TRANSPORT_BYTES,
) {
  chunks(encoded.byteLength, size);
  let confirmedBytes = await confirmedOffset(resource, encoded.byteLength);
  let attemptedBytes = 0;
  let patchRequests = 0;
  let recoveries = 0;
  const maximumRequests = Math.ceil(encoded.byteLength / size) + 4;
  while (confirmedBytes < encoded.byteLength) {
    if (patchRequests >= maximumRequests)
      throw new Error("Retry budget exhausted");
    const end = Math.min(confirmedBytes + size, encoded.byteLength);
    const part = encoded.slice(confirmedBytes, end);
    attemptedBytes += part.byteLength;
    patchRequests += 1;
    let response: Response;
    try {
      response = await fetch(resource, {
        method: "PATCH",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(confirmedBytes),
          "Content-Type": "application/offset+octet-stream",
        },
        body: part,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      recoveries += 1;
      confirmedBytes = await confirmedOffset(resource, encoded.byteLength);
      continue;
    }
    if (response.status === 409 || response.status >= 500) {
      recoveries += 1;
      confirmedBytes = await confirmedOffset(resource, encoded.byteLength);
      continue;
    }
    if (response.status !== 204)
      throw new Error(`PATCH status ${response.status}`);
    const next = byteCount(response.headers.get("Upload-Offset"));
    if (next !== end) throw new Error("Unexpected PATCH acknowledgement");
    confirmedBytes = next;
  }
  return { confirmedBytes, attemptedBytes, patchRequests, recoveries };
}
