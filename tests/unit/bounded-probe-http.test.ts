import { EventEmitter } from "node:events";
import { request } from "node:https";
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createBoundedProbeHttp,
  createBoundedProbeAuthHttp,
} from "../../src/lib/gateway/bounded-probe-http.server";
const endpoint = "https://example.invalid/storage/v1";
function fixture(
  options: {
    chunks?: number[];
    headers?: Record<string, string | undefined>;
    status?: number;
    lost?: boolean;
    hang?: boolean;
    complete?: boolean;
    auth?: { path: string; method: string; body?: string };
  } = {},
) {
  let peak = 0;
  const destroy = vi.fn();
  const transport = vi.fn((_url, _init, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };
    req.destroy = destroy;
    req.end = () => {
      queueMicrotask(() => {
        if (options.hang) return;
        if (options.lost) {
          req.emit("error", Error("lost"));
          return;
        }
        const res = Object.assign(new EventEmitter(), {
          statusCode: options.status ?? 200,
          headers: options.headers ?? { "content-length": "65536" },
          rawHeaders: Object.entries(
            options.headers ?? { "content-length": "65536" },
          ).flat(),
          rawTrailers: [],
          complete: options.complete ?? true,
          destroy,
        });
        callback(res);
        for (const size of options.chunks ?? [65536]) {
          if (destroy.mock.calls.length) break;
          peak = Math.max(peak, size);
          res.emit("data", Buffer.alloc(size));
        }
        res.emit("end");
      });
    };
    return req;
  });
  const fetch = options.auth
    ? createBoundedProbeAuthHttp(transport as unknown as typeof request)
    : createBoundedProbeHttp(endpoint, transport as unknown as typeof request);
  const run = (signal?: AbortSignal) =>
    fetch(
      options.auth
        ? `https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1${options.auth.path}`
        : `${endpoint}/object/bucket/key`,
      {
        redirect: "error",
        signal,
        method: options.auth?.method,
        body: options.auth?.body,
      },
    );
  return { run, transport, destroy, peak: () => peak };
}
describe("bounded raw probe HTTP", () => {
  it.each([
    { path: "/token?grant_type=password", method: "POST", body: "{}" },
    { path: "/user", method: "GET" },
  ])("accepts only bounded dedicated Auth routes %j", async (auth) => {
    const f = fixture({ auth });
    await f.run();
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    { path: "/token?grant_type=refresh_token", method: "POST", body: "{}" },
    { path: "/logout", method: "POST" },
    { path: "/user", method: "PUT" },
    { path: "/user?x=1", method: "GET" },
    { path: "/object/bucket/key", method: "GET" },
  ])("rejects other Auth operations before dispatch %j", async (auth) => {
    const f = fixture({ auth });
    await expect(f.run()).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    { status: 302 },
    { chunks: [65537] },
    { headers: { "content-encoding": "gzip", "content-length": "1" } },
  ])("fails Auth closed with no retries %j", async (options) => {
    const f = fixture({ ...options, auth: { path: "/user", method: "GET" } });
    await expect(f.run()).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("accepts exact ceiling without decompression or shared agent", async () => {
    const f = fixture();
    expect((await (await f.run()).arrayBuffer()).byteLength).toBe(65536);
    expect(f.transport.mock.calls[0][1]).toMatchObject({
      agent: false,
      highWaterMark: 4096,
      maxHeaderSize: 8192,
      headers: { "accept-encoding": "identity" },
    });
  });
  it.each([
    { chunks: [65537] },
    { headers: { "content-length": "65537" } },
    { headers: { "content-encoding": "gzip", "content-length": "1" } },
    { headers: {} },
    { headers: { "transfer-encoding": "gzip, chunked" } },
    { headers: { "content-length": "1", "transfer-encoding": "chunked" } },
    { status: 302 },
    { lost: true },
    { complete: false },
    { headers: { "content-length": "2" }, chunks: [1] },
  ])("fails closed once for %j", async (options) => {
    const f = fixture(options);
    await expect(f.run()).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.destroy).toHaveBeenCalled();
  });
  it("accepts bounded chunked transfer", async () => {
    const f = fixture({
      headers: { "transfer-encoding": "chunked" },
      chunks: [32768, 32768],
    });
    expect((await (await f.run()).arrayBuffer()).byteLength).toBe(65536);
  });
  it("destroys on the first overflowing chunk with bounded retention", async () => {
    const f = fixture({
      headers: { "transfer-encoding": "chunked" },
      chunks: Array(100000).fill(4096),
    });
    await expect(f.run()).rejects.toThrow("LIMIT");
    expect(f.peak()).toBe(4096);
    expect(f.destroy).toHaveBeenCalled();
  });
  it("times out a lost response without retry", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ hang: true });
      const assertion = expect(f.run()).rejects.toThrow("TIMEOUT");
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;
      expect(f.transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("aborts explicitly", async () => {
    const f = fixture({ hang: true });
    const controller = new AbortController();
    const assertion = expect(f.run(controller.signal)).rejects.toThrow(
      "ABORTED",
    );
    controller.abort();
    await assertion;
  });
});
