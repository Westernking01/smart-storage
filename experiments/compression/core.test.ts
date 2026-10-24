import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  DEFAULT_BLOCK,
  MAX_FILE,
  SAMPLE_CAP,
  hex,
  sampleRanges,
  useGzip,
  validateManifest,
  type Manifest,
} from "./core.js";

describe("experimental compression contracts", () => {
  it("uses the exact 98% threshold and rejects empty/tiny expansion", () => {
    expect(useGzip(100, 98)).toBe(true);
    expect(useGzip(100, 99)).toBe(false);
    expect(useGzip(0, 0)).toBe(false);
    expect(useGzip(1, 20)).toBe(false);
  });
  it("samples bounded nonoverlapping start/middle/end ranges", () => {
    for (const size of [
      0,
      1,
      SAMPLE_CAP,
      SAMPLE_CAP + 1,
      DEFAULT_BLOCK,
      MAX_FILE,
    ]) {
      const ranges = sampleRanges(size);
      expect(
        ranges.reduce((sum, [a, b]) => sum + b - a, 0),
      ).toBeLessThanOrEqual(SAMPLE_CAP);
      for (let i = 1; i < ranges.length; i++)
        expect(ranges[i][0]).toBeGreaterThanOrEqual(ranges[i - 1][1]);
      if (size) {
        expect(ranges[0][0]).toBe(0);
        expect(ranges.at(-1)?.[1]).toBe(size);
      }
    }
    expect(() => sampleRanges(MAX_FILE + 1)).toThrow();
  });
  it("incremental SHA matches independent crypto across segment boundaries", () => {
    const state = sha256.create();
    const independent = createHash("sha256");
    for (const size of [0, 1, 63, 64, 65, 65536]) {
      const bytes = new Uint8Array(size).fill(42);
      state.update(bytes);
      independent.update(bytes);
    }
    expect(bytesToHex(state.digest())).toBe(independent.digest("hex"));
    expect(hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  const empty: Manifest = {
    format: "compression-spike",
    version: 1,
    blockSize: DEFAULT_BLOCK,
    originalBytes: 0,
    originalSha256: hex(new Uint8Array()),
    blocks: [
      {
        index: 0,
        offset: 0,
        codec: "raw",
        originalBytes: 0,
        encodedBytes: 0,
        originalSha256: hex(new Uint8Array()),
        encodedSha256: hex(new Uint8Array()),
      },
    ],
  };
  it("validates empty source as one empty raw block", () =>
    expect(() => validateManifest(empty)).not.toThrow());
  it.each([
    "missing",
    "offset",
    "codec",
    "version",
    "oversized",
    "hash",
    "length",
  ])("rejects %s metadata before decoding", (kind) => {
    const m = structuredClone(empty);
    if (kind === "missing") m.blocks = [];
    if (kind === "offset") m.blocks[0].offset = 1;
    if (kind === "codec") m.blocks[0].codec = "zip" as "raw";
    if (kind === "version") m.version = 2 as 1;
    if (kind === "oversized") m.originalBytes = MAX_FILE + 1;
    if (kind === "hash") m.originalSha256 = "invalid";
    if (kind === "length") m.blocks[0].encodedBytes = 1;
    expect(() => validateManifest(m)).toThrow();
  });
});
