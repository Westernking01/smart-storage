import { createServer, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import type { request as httpsRequest } from "node:https";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createBoundedProbeHttp } from "../../src/lib/gateway/bounded-probe-http.server";

// Exercise the real HTTP/1 parser over loopback. Deliberately no TLS claim:
// only the injected transport's scheme is replaced; parser options are preserved.
async function localResponse(
  wire: string,
  check: (run: () => Promise<Response>) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  let attempts = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => {
      attempts++;
      socket.end(wire);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("FIXTURE_ADDRESS");
    const endpoint = `https://127.0.0.1:${address.port}/storage/v1`;
    const transport = ((url, options, callback) => {
      const local = new URL(url);
      local.protocol = "http:";
      return httpRequest(local, options, callback);
    }) as typeof httpsRequest;
    const fetch = createBoundedProbeHttp(endpoint, transport);
    await check(() =>
      fetch(`${endpoint}/object/bucket/key`, { redirect: "error" }),
    );
    expect(attempts).toBe(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("real local HTTP parser accounting (not TLS/physical accounting)", () => {
  it("excludes chunk extensions and delimiters from accepted body bytes", async () => {
    const wire =
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
      `1;ignored=${"x".repeat(1024)}\r\na\r\n`.repeat(128) +
      "0\r\n\r\n";
    expect(Buffer.byteLength(wire)).toBeGreaterThan(65536);
    await localResponse(wire, async (run) => {
      expect((await (await run()).arrayBuffer()).byteLength).toBe(128);
    });
  });
  it.each([
    "HTTP/1.1 200 OK\r\nX-Large: " +
      "x".repeat(9000) +
      "\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10001\r\n" +
      "a".repeat(65537) +
      "\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na",
    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1\r\n\r\na",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\nX-Trailer: value\r\n\r\n",
    "",
  ])(
    "rejects malformed, oversized, compressed or lost response %#",
    async (wire) => {
      await localResponse(wire, async (run) => {
        await expect(run()).rejects.toThrow();
      });
    },
  );
});
