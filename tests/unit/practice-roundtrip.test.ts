import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { practiceRoundTrip } from "../../experiments/storage/practice-roundtrip-core";

function setup(
  options: {
    list?: unknown;
    claim?: boolean;
    corrupt?: boolean;
    uncertain?: boolean;
    identity?: string;
    confirm?: string;
  } = {},
) {
  const uid = "310d0ec8-84ca-423a-b646-0480a20edc09";
  const token = `e30.${Buffer.from(JSON.stringify({ sub: uid, role: "authenticated", iss: "https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.synthetic`;
  const hidden = vi.fn(async (prompt: string) =>
    prompt.includes("Separate practice")
      ? "AUTHORIZE ONE PRACTICE ROUNDTRIP"
      : prompt.includes("publishable")
        ? "sb_publishable_synthetic"
        : prompt.includes("NOW run")
          ? (options.confirm ?? "FRESH KEY AND CLAIM ABSENT")
          : "synthetic-private",
  );
  const transport = vi.fn<typeof fetch>(async (url) => {
    const s = String(url);
    if (s.includes("token?"))
      return Response.json({
        access_token: token,
        token_type: "bearer",
        user: { id: uid },
      });
    if (s.endsWith("/user"))
      return Response.json({
        id: options.identity ?? uid,
        role: "authenticated",
      });
    if (s.includes("/rpc/")) {
      if (options.uncertain) throw Error("synthetic-private");
      return Response.json(options.claim ?? true);
    }
    return Response.json(options.list ?? []);
  });
  let uploaded: Uint8Array;
  const native = vi.fn((url, init, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      end: (b?: Uint8Array) => void;
      destroy: () => void;
    };
    req.destroy = () => {};
    req.end = (b) => {
      if (b) uploaded = b;
      queueMicrotask(() => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 200,
          headers: {},
          complete: true,
          destroy() {},
        });
        callback(res);
        const bytes =
          init.method === "POST"
            ? new TextEncoder().encode("{}")
            : options.corrupt
              ? new Uint8Array([1])
              : uploaded;
        res.emit("data", Buffer.from(bytes));
        res.emit("end");
      });
    };
    return req;
  });
  return {
    hidden,
    transport,
    native,
    run: () =>
      practiceRoundTrip({
        hidden,
        transport,
        nativeRequest: native as unknown as typeof request,
      }),
  };
}
it("verifies one create-only compressed round trip with sanitized HTTP report", async () => {
  const s = setup();
  const r = await s.run();
  expect(r).toMatchObject({
    outcome: "PASS",
    sourceBytes: 4736,
    encodedBytes: 89,
    downloadedBytes: 89,
    restoredBytes: 4736,
    verified: true,
  });
  expect(r.http.map((x) => x.operation)).toEqual([
    "login",
    "identity",
    "absence-list",
    "claim-upload",
    "upload",
    "claim-download",
    "download",
  ]);
  expect(s.native).toHaveBeenCalledTimes(2);
  expect(s.native.mock.calls[0][1].headers["x-upsert"]).toBe("false");
  expect(JSON.stringify(r)).not.toContain("synthetic-private");
  expect(r.downloadedSha256).toBe(r.encodedSha256);
  expect(r.restoredSha256).toBe(r.sourceSha256);
});
it.each([
  { list: [{ name: "compressed-test-001.bin" }] },
  { list: {} },
  { claim: false },
  { uncertain: true },
  { identity: "wrong" },
  { confirm: "UNKNOWN" },
])("stops before upload for unsafe prerequisites %j", async (options) => {
  const s = setup(options);
  expect((await s.run()).outcome).toBe("FAIL");
  expect(s.native).not.toHaveBeenCalled();
});
it("rejects corrupted download without retry", async () => {
  const s = setup({ corrupt: true });
  const r = await s.run();
  expect(r.outcome).toBe("FAIL");
  expect(r.stage).toBe("integrity");
  expect(s.native).toHaveBeenCalledTimes(2);
});

