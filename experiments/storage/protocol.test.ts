import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  byteCount,
  chunks,
  confirmedOffset,
  localResource,
  LOGICAL_BYTES,
  resumeLocal,
  TRANSPORT_BYTES,
} from "./protocol";

/** Deliberately artificial model: no Supabase, JWT, RLS, persistence or cloud access. */
async function model(
  length: number,
  fault:
    | "none"
    | "ambiguous"
    | "partial"
    | "conflict"
    | "forbidden"
    | "expired" = "none",
) {
  let stored = Buffer.alloc(0);
  let injected = false;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    response.setHeader("Tus-Resumable", "1.0.0");
    response.setHeader("Upload-Length", length);
    if (request.method === "HEAD") {
      response.setHeader("Upload-Offset", stored.length);
      response.writeHead(fault === "expired" ? 410 : 200).end();
      return;
    }
    if (request.method !== "PATCH") {
      response.writeHead(405).end();
      return;
    }
    if (fault === "forbidden") {
      response.writeHead(403).end();
      return;
    }
    const buffers: Buffer[] = [];
    for await (const buffer of request) buffers.push(Buffer.from(buffer));
    const body = Buffer.concat(buffers);
    if (Number(request.headers["upload-offset"]) !== stored.length) {
      response.writeHead(409).end();
      return;
    }
    if (stored.length + body.length > length || body.length > TRANSPORT_BYTES) {
      response.writeHead(413).end();
      return;
    }
    if (!injected && fault === "conflict") {
      injected = true;
      response.writeHead(409).end();
      return;
    }
    if (!injected && fault === "partial") {
      injected = true;
      stored = Buffer.concat([stored, body.subarray(0, 2)]);
      response.destroy();
      return;
    }
    stored = Buffer.concat([stored, body]);
    if (!injected && fault === "ambiguous") {
      injected = true;
      response.destroy();
      return;
    }
    response.setHeader("Upload-Offset", stored.length);
    response.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = new URL(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/model`,
  );
  return {
    url,
    bytes: () => stored,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

describe("LOCAL MODEL ONLY — no Supabase evidence", () => {
  it("plans 8 MiB as 6 MiB plus a final 2 MiB", () => {
    expect(chunks(LOGICAL_BYTES)).toEqual([TRANSPORT_BYTES, 2 * 1024 * 1024]);
    expect(chunks(0)).toEqual([]);
    expect(chunks(3)).toEqual([3]);
  });
  it("rejects malformed, missing and unsafe offsets", () => {
    for (const value of [
      null,
      "",
      "-1",
      "1.5",
      " 2",
      "02",
      "9007199254740992",
    ]) {
      expect(() => byteCount(value)).toThrow();
    }
    expect(byteCount("0")).toBe(0);
  });
  it("rejects out-of-envelope fixtures and invalid chunks", () => {
    expect(() => chunks(LOGICAL_BYTES + 1)).toThrow();
    expect(() => chunks(1, 0)).toThrow();
  });
  it("cannot send a probe to a provider or follow external capabilities", () => {
    expect(() =>
      localResource("http://example.com/object", "http://127.0.0.1:1234/"),
    ).toThrow();
    expect(() =>
      localResource("/object", "https://project.supabase.co/"),
    ).toThrow();
    expect(() =>
      localResource("/object?token=secret", "http://127.0.0.1:1234/"),
    ).toThrow();
  });
  it("transfers bounded 8 MiB raw bytes over actual loopback HTTP", async () => {
    const bytes = new Uint8Array(LOGICAL_BYTES).fill(73);
    const endpoint = await model(bytes.length);
    try {
      const result = await resumeLocal(endpoint.url, bytes);
      expect(result).toEqual({
        confirmedBytes: bytes.length,
        attemptedBytes: bytes.length,
        patchRequests: 2,
        recoveries: 0,
      });
      expect(endpoint.bytes().equals(Buffer.from(bytes))).toBe(true);
      expect(endpoint.requests()).toBe(3);
    } finally {
      await endpoint.close();
    }
  });
  it("transfers one compressed block and restores exact original bytes", async () => {
    const original = Buffer.alloc(1024, 65);
    const encoded = gzipSync(original, { mtime: 0 } as Parameters<
      typeof gzipSync
    >[1]);
    const endpoint = await model(encoded.length);
    try {
      const result = await resumeLocal(endpoint.url, encoded);
      expect(result.confirmedBytes).toBe(encoded.length);
      expect(gunzipSync(endpoint.bytes()).equals(original)).toBe(true);
    } finally {
      await endpoint.close();
    }
  });
  for (const fault of ["ambiguous", "partial", "conflict"] as const) {
    it(`reconciles HEAD after modeled ${fault} response`, async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
      const endpoint = await model(bytes.length, fault);
      try {
        const result = await resumeLocal(endpoint.url, bytes, 4);
        expect(result.confirmedBytes).toBe(7);
        expect(result.recoveries).toBe(1);
        expect(endpoint.bytes().equals(Buffer.from(bytes))).toBe(true);
        if (fault !== "ambiguous")
          expect(result.attemptedBytes).toBeGreaterThan(7);
      } finally {
        await endpoint.close();
      }
    });
  }
  it("restarts a client from HEAD using exactly the same encoded bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const endpoint = await model(bytes.length);
    try {
      await fetch(endpoint.url, {
        method: "PATCH",
        headers: { "Upload-Offset": "0" },
        body: bytes.slice(0, 2),
      });
      const result = await resumeLocal(endpoint.url, bytes, 2);
      expect(result.attemptedBytes).toBe(2);
      expect(result.confirmedBytes).toBe(4);
    } finally {
      await endpoint.close();
    }
  });
  it("represents an empty modeled object without PATCH", async () => {
    const endpoint = await model(0);
    try {
      expect(
        (await resumeLocal(endpoint.url, new Uint8Array())).patchRequests,
      ).toBe(0);
    } finally {
      await endpoint.close();
    }
  });
  it("stops on expiry without automatically allocating another resource", async () => {
    const endpoint = await model(1, "expired");
    try {
      await expect(confirmedOffset(endpoint.url, 1)).rejects.toThrow("410");
      expect(endpoint.requests()).toBe(1);
    } finally {
      await endpoint.close();
    }
  });
  it("does not retry authorization denial as a transient failure", async () => {
    const endpoint = await model(1, "forbidden");
    try {
      await expect(
        resumeLocal(endpoint.url, new Uint8Array([1])),
      ).rejects.toThrow("403");
      expect(endpoint.bytes().length).toBe(0);
    } finally {
      await endpoint.close();
    }
  });
  it("demonstrates why bucket caps do not enforce smaller reservations", () => {
    const bucketCap = 16;
    const reserved = 8;
    const attempted = 12;
    expect(attempted <= bucketCap).toBe(true);
    expect(attempted <= reserved).toBe(false);
    // Accounting equations are models, not proof that a provider evaluates them.
    expect(2 * bucketCap > 2 * reserved).toBe(true);
  });
  it("models no-upsert allocation and cancellation accounting, not RLS", () => {
    const completed = new Set(["allocated-object"]);
    expect(completed.has("allocated-object")).toBe(true);
    const reservation = { heldBytes: 8, outstandingCapability: true };
    const mayRelease = !reservation.outstandingCapability;
    expect(mayRelease).toBe(false);
    expect(reservation.heldBytes).toBe(8);
  });
});
