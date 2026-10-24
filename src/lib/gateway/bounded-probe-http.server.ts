import "server-only";
import { request as httpsRequest } from "node:https";
import type { HttpFetch } from "./supabase-storage-transport.server";

/** Node HTTP/1 client: raw (never decompressed) body, fixed retention buffer.
 * Counts IncomingMessage data bytes after HTTP transfer decoding, before any
 * content decoding (nonidentity encoding is rejected). Headers/trailers, chunk
 * sizes/extensions/delimiters, request bytes and TLS/TCP/IP overhead are excluded.
 * Overflowing chunks are rejected before copying; they have already arrived.
 * maxHeaderSize is a parser limit; highWaterMark is not a network-byte ceiling.
 * No global fetch, agents, redirects, retries or browser entry point. */
export function createBoundedProbeHttp(
  endpoint: string,
  request: typeof httpsRequest = httpsRequest,
): HttpFetch {
  return boundedHttp(endpoint, request, false);
}

/** Separate, pinned Auth scope; never expands the Storage client's allowlist. */
export function createBoundedProbeAuthHttp(
  request: typeof httpsRequest = httpsRequest,
): HttpFetch {
  return boundedHttp(
    "https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1",
    request,
    true,
  );
}

function boundedHttp(
  endpoint: string,
  request: typeof httpsRequest,
  auth: boolean,
): HttpFetch {
  const base = new URL(endpoint);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error("INVALID_PROBE_ENDPOINT");
  return async (url, init) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const list =
      method === "POST" &&
      target.pathname.startsWith(`${base.pathname}/object/list/`);
    const signIn =
      auth &&
      method === "POST" &&
      target.pathname === `${base.pathname}/token` &&
      target.search === "?grant_type=password";
    const identity =
      auth &&
      method === "GET" &&
      target.pathname === `${base.pathname}/user` &&
      !target.search;
    if (
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      target.hash ||
      (auth
        ? !(signIn || identity)
        : Boolean(target.search) ||
          !(
            (method === "GET" &&
              target.pathname.startsWith(`${base.pathname}/object/`)) ||
            list
          )) ||
      init.redirect !== "error" ||
      (init.body != null &&
        (!(list || signIn) ||
          typeof init.body !== "string" ||
          Buffer.byteLength(init.body) > 4096))
    )
      throw Error("PROBE_HTTP_SCOPE");
    init.signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const buffer = Buffer.alloc(65536);
      let used = 0;
      let settled = false;
      let req: ReturnType<typeof httpsRequest> | undefined;
      const finish = (error?: Error, response?: Response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", abort);
        if (error) {
          req?.destroy();
          reject(error);
        } else resolve(response!);
      };
      const abort = () => finish(Error("PROBE_HTTP_ABORTED"));
      const timer = setTimeout(
        () => finish(Error("PROBE_HTTP_TIMEOUT")),
        30000,
      );
      init.signal?.addEventListener("abort", abort, { once: true });
      try {
        const headers = new Headers(init.headers);
        headers.set("accept-encoding", "identity");
        headers.set("connection", "close");
        req = request(
          target,
          {
            method,
            headers: Object.fromEntries(headers),
            agent: false,
            maxHeaderSize: 8192,
            ...({ highWaterMark: 4096 } as { highWaterMark: number }),
          },
          (res) => {
            const fail = (reason: string) => {
              finish(Error(reason));
              res.destroy();
            };
            res.on("error", () => fail("PROBE_HTTP_RESPONSE_LOST"));
            res.on("aborted", () => fail("PROBE_HTTP_RESPONSE_LOST"));
            const status = res.statusCode ?? 0;
            const encoding = res.headers["content-encoding"];
            const length = res.headers["content-length"];
            const transfer = res.headers["transfer-encoding"];
            // Reject ambiguous/duplicate headers even in injected transports.
            const names = res.rawHeaders
              .filter((_, i) => i % 2 === 0)
              .map((v) => v.toLowerCase());
            if (
              ["content-length", "transfer-encoding", "content-encoding"].some(
                (n) => names.filter((v) => v === n).length > 1,
              )
            )
              return fail("PROBE_HTTP_FRAMING");
            if (status < 200 || status >= 300) return fail("PROBE_HTTP_STATUS");
            if (encoding !== undefined && encoding !== "identity")
              return fail("PROBE_HTTP_ENCODING");
            if (
              (length !== undefined && transfer !== undefined) ||
              (length === undefined && transfer !== "chunked") ||
              (transfer !== undefined && transfer !== "chunked") ||
              (length !== undefined &&
                (!/^\d+$/.test(length) ||
                  !Number.isSafeInteger(Number(length))))
            )
              return fail("PROBE_HTTP_FRAMING");
            if (length !== undefined && Number(length) > buffer.length)
              return fail("PROBE_HTTP_LIMIT");
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              if (
                !Buffer.isBuffer(chunk) ||
                chunk.length > buffer.length - used
              )
                return fail("PROBE_HTTP_LIMIT");
              chunk.copy(buffer, used);
              used += chunk.length;
            });
            res.on("end", () => {
              if (settled) return;
              if (
                !res.complete ||
                (length !== undefined && used !== Number(length)) ||
                res.rawTrailers.length
              )
                return fail("PROBE_HTTP_FRAMING");
              const outputHeaders = new Headers();
              for (const [name, value] of Object.entries(res.headers))
                if (typeof value === "string" && name !== "transfer-encoding")
                  outputHeaders.set(name, value);
              outputHeaders.set("content-length", String(used));
              finish(
                undefined,
                new Response(new Uint8Array(buffer.subarray(0, used)), {
                  status,
                  headers: outputHeaders,
                }),
              );
            });
            res.on("close", () => {
              if (!res.complete) fail("PROBE_HTTP_RESPONSE_LOST");
            });
          },
        );
        req.on("error", () => finish(Error("PROBE_HTTP_CONNECTION_FAILURE")));
        if (init.signal?.aborted) return abort();
        req.end(init.body ?? undefined);
      } catch {
        finish(Error("PROBE_HTTP_FAILURE"));
      }
    });
  };
}
