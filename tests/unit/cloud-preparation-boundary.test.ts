import { expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
vi.mock("server-only", () => ({}));
import { requireCloudPreparationProvenance } from "../../src/lib/backend/cloud-preparation-provenance.server";
import { digest } from "../../src/lib/transfers/codec";
const original = new TextEncoder().encode(
  "trusted restoration fixture".repeat(100),
);
const body = new Uint8Array(gzipSync(original));
const allocation = {
  codec: "gzip",
  original_bytes: original.length,
  encoded_bytes: body.length,
  original_sha256: digest(original),
  encoded_sha256: digest(body),
};
it("verifies encoded integrity and restored original independently without browser flags", async () => {
  await expect(
    requireCloudPreparationProvenance(body, allocation, 65536),
  ).resolves.toBeUndefined();
});
it.each([
  { codec: "raw" },
  { original_bytes: 65537 },
  { encoded_bytes: body.length + 1 },
  { encoded_sha256: "0".repeat(64) },
  { original_sha256: "0".repeat(64) },
  { original_bytes: original.length - 1 },
])("rejects invalid allocation or content metadata %j", async (change) => {
  await expect(
    requireCloudPreparationProvenance(
      body,
      { ...allocation, ...change },
      65536,
    ),
  ).rejects.toThrow();
});
it.each(["raw", "truncated", "corrupt"])(
  "rejects %s bytes despite matching encoded hash and forged marker",
  async (kind) => {
    const bytes = kind === "raw" ? original : body.slice(0, body.length - 2);
    if (kind === "corrupt") bytes[0] ^= 1;
    await expect(
      requireCloudPreparationProvenance(
        bytes,
        {
          ...allocation,
          encoded_bytes: bytes.length,
          encoded_sha256: digest(bytes),
          verifiedPreparation: "a".repeat(64),
        },
        65536,
      ),
    ).rejects.toThrow("STAGED_INTEGRITY");
  },
);
