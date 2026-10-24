import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { describe, it, expect, vi } from "vitest";
import template from "../../experiments/storage/disposable-upload.config.template.json";
import { disposableUploadTarget as target } from "../../experiments/storage/disposable-upload-contract";
import {
  prepareDisposableFixture,
  executeDisposableRoundTrip,
  filesystemAttemptClaims,
  disposableSupabaseAdapter,
} from "../../experiments/storage/disposable-roundtrip-executor";

const session = {
  source: "external-verified-ordinary-session" as const,
  userId: target.userId,
  issuer: "https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1" as const,
  role: "authenticated" as const,
  accessToken: "mock-token",
  expiresAt: 2000,
};
async function setup() {
  const f = await prepareDisposableFixture();
  const used = new Set<string>();
  return {
    ...f,
    config: {
      ...template,
      ...Object.fromEntries(
        Object.entries(f).filter(([k]) => k !== "source" && k !== "encoded"),
      ),
      enabled: true,
      fixtureVerificationReference: "mock independent review",
      createReadPermissionReviewReference: "mock permissions",
    },
    authorization: {
      project: target.project,
      bucket: target.bucket,
      key: target.key,
      upload: 1,
      download: 1,
      expiresAt: 2000,
    },
    session: vi.fn(async () => session),
    now: () => 1000,
    claimOnce: vi.fn(async (key: string) => {
      if (used.has(key)) return false;
      used.add(key);
      return true;
    }),
    provider: {
      create: vi.fn(async () => {}),
      download: vi.fn(async () => f.encoded.slice()),
    },
  };
}
describe("offline disposable executor", () => {
  it("verifies gzip bytes and restored bytes", async () => {
    const f = await setup();
    expect(await executeDisposableRoundTrip(f)).toEqual({
      verified: true,
      sourceBytes: f.source.length,
      encodedBytes: f.encoded.length,
    });
    expect(f.encoded.length).toBeLessThan(f.source.length);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.download).toHaveBeenCalledTimes(1);
  });
  it.each(["conflict", "interrupted", "uncertain"])(
    "retains %s upload and never downloads/retries",
    async (reason) => {
      const f = await setup();
      f.provider.create.mockRejectedValue(Error(reason));
      await expect(executeDisposableRoundTrip(f)).rejects.toThrow(reason);
      await expect(executeDisposableRoundTrip(f)).rejects.toThrow(
        "ATTEMPT_USED",
      );
      expect(f.provider.create).toHaveBeenCalledTimes(1);
      expect(f.provider.download).not.toHaveBeenCalled();
    },
  );
  it.each(["truncated", "corrupt", "oversize"])(
    "rejects %s download",
    async (kind) => {
      const f = await setup();
      const bad =
        kind === "oversize"
          ? new Uint8Array(65537)
          : f.encoded.slice(0, kind === "truncated" ? -1 : undefined);
      bad[0] ^= 1;
      f.provider.download.mockResolvedValue(bad);
      await expect(executeDisposableRoundTrip(f)).rejects.toThrow(
        "ENCODED_INTEGRITY",
      );
      await expect(executeDisposableRoundTrip(f)).rejects.toThrow(
        "ATTEMPT_USED",
      );
    },
  );
  it("fails preflight before credentials or claims", async () => {
    const f = await setup();
    f.config.enabled = false;
    await expect(executeDisposableRoundTrip(f)).rejects.toThrow("DISABLED");
    expect(f.session).not.toHaveBeenCalled();
    expect(f.claimOnce).not.toHaveBeenCalled();
  });
  it.each([
    { ...session, role: "service_role" },
    { ...session, expiresAt: 1000 },
    { ...session, userId: "other" },
  ])("rejects unapproved/expired session", async (s) => {
    const f = await setup();
    await expect(
      executeDisposableRoundTrip({ ...f, session: async () => s }),
    ).rejects.toThrow();
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it("retains real local claims across new instances and empty interrupted records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "disposable-roundtrip-"));
    try {
      const f = await setup();
      const claimOnce = filesystemAttemptClaims(dir);
      f.provider.create.mockRejectedValue(Error("lost response"));
      await expect(
        executeDisposableRoundTrip({ ...f, claimOnce }),
      ).rejects.toThrow("lost response");
      const [name] = await readdir(dir);
      await writeFile(join(dir, name), "");
      await expect(
        executeDisposableRoundTrip({
          ...f,
          claimOnce: filesystemAttemptClaims(dir),
        }),
      ).rejects.toThrow("ATTEMPT_USED");
      expect(f.provider.create).toHaveBeenCalledTimes(1);
      const races = await Promise.all([
        claimOnce("race"),
        filesystemAttemptClaims(dir)("race"),
      ]);
      expect(races.sort()).toEqual([false, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function mockHttps(
  status = 200,
  chunks = [Buffer.from("mock")],
  complete = true,
) {
  const calls: unknown[][] = [];
  const native = ((...args: unknown[]) => {
    calls.push(args);
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: object;
          complete: boolean;
          destroy: () => void;
        };
        Object.assign(res, {
          statusCode: status,
          headers: {},
          complete,
          destroy: () => {},
        });
        (args[2] as (r: unknown) => void)(res);
        for (const chunk of chunks) res.emit("data", chunk);
        res.emit("end");
      });
    return req;
  }) as unknown as typeof request;
  return { native, calls };
}
describe("narrow Supabase adapter (mock HTTPS only)", () => {
  it("uses exact create-only and authenticated paths", async () => {
    const h = mockHttps();
    const p = disposableSupabaseAdapter(h.native);
    await p.create(new Uint8Array([1]), session);
    await p.download(session);
    expect(h.calls.map((c) => c[0])).toEqual([
      `${target.endpoint}/object/${target.bucket}/${target.key}`,
      `${target.endpoint}/object/authenticated/${target.bucket}/${target.key}`,
    ]);
    expect(h.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "x-upsert": "false", "content-length": "1" },
    });
  });
  it.each([302, 409, 401, 500])(
    "halts status %s without retries",
    async (status) => {
      const h = mockHttps(status);
      await expect(
        disposableSupabaseAdapter(h.native).create(
          new Uint8Array([1]),
          session,
        ),
      ).rejects.toThrow("UNCERTAIN");
      expect(h.calls).toHaveLength(1);
    },
  );
  it("rejects oversized and interrupted responses", async () => {
    for (const h of [
      mockHttps(200, [Buffer.alloc(65537)]),
      mockHttps(200, [], false),
    ])
      await expect(
        disposableSupabaseAdapter(h.native).download(session),
      ).rejects.toThrow("UNCERTAIN");
  });
});
