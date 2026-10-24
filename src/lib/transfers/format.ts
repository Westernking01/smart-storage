// Compatible reader/writer for Task 1.3B's existing experimental format.
// This is not the proposed production smart-storage manifest v1.
export const BLOCK_BYTES = 8 * 1024 * 1024;
export const FILE_BYTES = 32 * 1024 * 1024;
export const HASH = /^[a-f0-9]{64}$/;
export interface Block {
  index: number;
  offset: number;
  originalBytes: number;
  encodedBytes: number;
  codec: "raw" | "gzip";
  originalSha256: string;
  encodedSha256: string;
}
export interface Manifest {
  format: "compression-spike";
  version: 1;
  blockSize: number;
  originalBytes: number;
  originalSha256: string;
  blocks: Block[];
}
export function fail(code: string): never {
  throw new Error(code);
}
export const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
export function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("INVALID_RECORD");
  return v as Record<string, unknown>;
}
export function parseBlock(
  v: unknown,
  index: number,
  offset: number,
  size: number,
): Block {
  const b = record(v);
  if (
    b.index !== index ||
    b.offset !== offset ||
    b.originalBytes !== size ||
    !integer(b.encodedBytes) ||
    b.encodedBytes > BLOCK_BYTES ||
    (b.codec !== "raw" && b.codec !== "gzip") ||
    typeof b.originalSha256 !== "string" ||
    !HASH.test(b.originalSha256) ||
    typeof b.encodedSha256 !== "string" ||
    !HASH.test(b.encodedSha256) ||
    (b.codec === "raw" && b.encodedBytes !== size) ||
    (b.codec === "gzip" && (b.encodedBytes < 18 || size === 0))
  )
    fail("INVALID_BLOCK");
  return {
    index,
    offset,
    originalBytes: size,
    encodedBytes: b.encodedBytes,
    codec: b.codec,
    originalSha256: b.originalSha256,
    encodedSha256: b.encodedSha256,
  };
}
export function parseManifest(value: unknown): Manifest {
  const m = record(value);
  if (
    m.format !== "compression-spike" ||
    m.version !== 1 ||
    !integer(m.originalBytes) ||
    m.originalBytes > FILE_BYTES ||
    !integer(m.blockSize) ||
    m.blockSize < 65536 ||
    m.blockSize > BLOCK_BYTES ||
    typeof m.originalSha256 !== "string" ||
    !HASH.test(m.originalSha256) ||
    !Array.isArray(m.blocks) ||
    m.blocks.length > 128 ||
    m.blocks.length !== Math.max(1, Math.ceil(m.originalBytes / m.blockSize))
  )
    fail("INVALID_MANIFEST");
  const blocks = m.blocks.map((b, i) =>
    parseBlock(
      b,
      i,
      i * Number(m.blockSize),
      Math.min(
        Number(m.blockSize),
        Number(m.originalBytes) - i * Number(m.blockSize),
      ),
    ),
  );
  if (blocks.some((b) => b.encodedBytes > Number(m.blockSize)))
    fail("INVALID_BLOCK");
  const result: Manifest = {
    format: "compression-spike",
    version: 1,
    blockSize: m.blockSize,
    originalBytes: m.originalBytes,
    originalSha256: m.originalSha256,
    blocks,
  };
  if (new TextEncoder().encode(JSON.stringify(value)).length > 128 * 1024)
    fail("MANIFEST_LIMIT");
  return result;
}
export function parseManifestBytes(bytes: Uint8Array): Manifest {
  if (bytes.byteLength > 128 * 1024) fail("MANIFEST_LIMIT");
  return parseManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
// Stable serialization for checkpoint integrity, never a production-format claim.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
