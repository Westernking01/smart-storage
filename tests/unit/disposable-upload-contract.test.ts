import { describe, expect, it, vi } from "vitest";
import template from "../../experiments/storage/disposable-upload.config.template.json";
import {
  disposableUploadAttemptGate,
  disposableUploadConfigSchema,
  preflightDisposableUpload,
} from "../../experiments/storage/disposable-upload-contract";
import { digest, encodeBlock } from "../../src/lib/transfers/codec";

async function fixture() {
  const source = new TextEncoder().encode(
    "offline compression test ".repeat(100),
  );
  const encoded = await encodeBlock(source);
  expect(encoded.codec).toBe("gzip");
  return {
    source,
    encoded: encoded.bytes,
    config: {
      ...template,
      enabled: true,
      sourceBytes: source.length,
      encodedBytes: encoded.bytes.length,
      sourceSha256: digest(source),
      encodedSha256: digest(encoded.bytes),
      fixtureVerificationReference: "mock independent fixture record",
      createReadPermissionReviewReference: "mock exact-key create/read review",
    },
  };
}

describe("disposable upload offline contract", () => {
  it("accepts the exact pinned configuration and verified gzip round trip", async () => {
    const f = await fixture();
    const result = await preflightDisposableUpload(
      f.config,
      f.source,
      f.encoded,
    );
    expect(result.key).toBe(template.key);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.operations)).toBe(true);
  });
  it("keeps incomplete shipped configuration disabled even if toggled", async () => {
    expect(template.enabled).toBe(false);
    expect(disposableUploadConfigSchema.safeParse(template).success).toBe(
      false,
    );
    expect(
      disposableUploadConfigSchema.safeParse({ ...template, enabled: true })
        .success,
    ).toBe(false);
    const f = await fixture();
    const { enabled, ...withoutEnabled } = f.config;
    void enabled;
    expect(disposableUploadConfigSchema.parse(withoutEnabled).enabled).toBe(
      false,
    );
    await expect(
      preflightDisposableUpload(withoutEnabled, f.source, f.encoded),
    ).rejects.toThrow("DISABLED");
  });
  it.each([
    ["project", "fneuqneqaopkmpeevlqz"],
    ["project", "other-project"],
    ["endpoint", "https://fneuqneqaopkmpeevlqz.supabase.co/storage/v1"],
    ["userId", "00000000-0000-4000-8000-000000000001"],
    ["bucket", "other-bucket"],
    ["privateBucket", false],
    ["key", "gateway-probe/v1/probe-fixture-v1.txt"],
    ["key", "practice-roundtrip/20261019/another.bin"],
    ["upsert", true],
    ["overwrite", true],
    ["delete", true],
    ["retries", 1],
    ["redirects", 1],
    ["applicationEnvironmentFallback", true],
    ["credentialSource", "application-environment"],
    ["credentialSource", "service_role"],
    ["sourceBytes", 0],
    ["sourceBytes", 65537],
    ["sourceBytes", 1.5],
    ["encodedBytes", 65537],
    ["encodedBytes", -1],
    ["sourceSha256", "invalid"],
    ["encodedSha256", "A".repeat(64)],
    ["fixtureVerificationReference", ""],
    ["createReadPermissionReviewReference", ""],
    ["maximumUploadBytes", 65537],
    ["maximumDownloadBytes", 65537],
    ["operations", { upload: 2, download: 1 }],
    ["operations", { upload: 1, download: 1, delete: 1 }],
    ["codec", "raw"],
    ["timeoutMs", 60000],
    ["apiKey", "mock-rejected-field"],
  ])("rejects changed or unsafe field %s (%s)", async (field, value) => {
    const f = await fixture();
    await expect(
      preflightDisposableUpload(
        { ...f.config, [field]: value },
        f.source,
        f.encoded,
      ),
    ).rejects.toThrow();
  });
  it.each(["sourceSha256", "encodedSha256", "sourceBytes", "encodedBytes"])(
    "requires %s",
    async (field) => {
      const f = await fixture();
      const candidate: Record<string, unknown> = { ...f.config };
      delete candidate[field];
      await expect(
        preflightDisposableUpload(candidate, f.source, f.encoded),
      ).rejects.toThrow();
    },
  );
  it("rejects mismatched source/encoded hashes and lengths", async () => {
    const f = await fixture();
    for (const change of [
      { sourceSha256: "0".repeat(64) },
      { encodedSha256: "0".repeat(64) },
      { sourceBytes: f.source.length + 1 },
      { encodedBytes: f.encoded.length + 1 },
    ])
      await expect(
        preflightDisposableUpload(
          { ...f.config, ...change },
          f.source,
          f.encoded,
        ),
      ).rejects.toThrow("INTEGRITY");
  });
  it("rejects bytes with valid independent hashes that do not restore to source", async () => {
    const f = await fixture();
    f.source[0] ^= 1;
    await expect(
      preflightDisposableUpload(
        { ...f.config, sourceSha256: digest(f.source) },
        f.source,
        f.encoded,
      ),
    ).rejects.toThrow("INTEGRITY");
  });
  it("rejects corrupt gzip even with its updated encoded hash", async () => {
    const f = await fixture();
    f.encoded[0] = 0;
    await expect(
      preflightDisposableUpload(
        { ...f.config, encodedSha256: digest(f.encoded) },
        f.source,
        f.encoded,
      ),
    ).rejects.toThrow();
  });
  it("consumes one durable attempt per operation across gate instances", async () => {
    const used = new Set<string>();
    const claim = vi.fn(async (key: string) => {
      if (used.has(key)) return false;
      used.add(key);
      return true;
    });
    const gate = disposableUploadAttemptGate(claim);
    await gate("upload");
    await gate("download");
    await expect(gate("upload")).rejects.toThrow("ATTEMPT_USED");
    await expect(gate("download")).rejects.toThrow("ATTEMPT_USED");
    await expect(disposableUploadAttemptGate(claim)("upload")).rejects.toThrow(
      "ATTEMPT_USED",
    );
    expect([...used]).toEqual(
      ["upload", "download"].map(
        (op) => `${template.project}/${template.bucket}/${template.key}/${op}`,
      ),
    );
  });
  it("rejects concurrent duplicate attempts and consumes ambiguous claim failures", async () => {
    const gate = disposableUploadAttemptGate(async () => {
      throw Error("ambiguous");
    });
    const results = await Promise.allSettled([gate("upload"), gate("upload")]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    await expect(gate("upload")).rejects.toThrow("ATTEMPT_USED");
  });
  it("rejects unsupported operations before claiming", async () => {
    const claim = vi.fn(async () => true);
    // Deliberately bypass static typing at the untrusted boundary.
    await expect(
      disposableUploadAttemptGate(claim)("delete" as "upload"),
    ).rejects.toThrow("OPERATION");
    expect(claim).not.toHaveBeenCalled();
  });
});
