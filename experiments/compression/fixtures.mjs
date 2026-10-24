import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
const MiB = 1024 * 1024;
export const specs = [
  { name: "empty", size: 0, kind: "text" },
  { name: "one-byte", size: 1, kind: "text" },
  { name: "small-text", size: 127, kind: "text" },
  { name: "repetitive", size: MiB, kind: "text" },
  { name: "csv", size: MiB, kind: "csv" },
  { name: "json", size: MiB, kind: "json" },
  { name: "seeded-random", size: MiB, kind: "random" },
  { name: "already-compressed", size: MiB, kind: "compressed" },
  { name: "mixed", size: 8 * MiB + MiB, kind: "mixed" },
  { name: "boundary-minus", size: 8 * MiB - 1, kind: "text" },
  { name: "boundary-exact", size: 8 * MiB, kind: "text" },
  { name: "boundary-plus", size: 8 * MiB + 1, kind: "text" },
  { name: "sampling-false-negative", size: 8 * MiB, kind: "false-negative" },
  { name: "sampling-false-positive", size: 8 * MiB, kind: "false-positive" },
  { name: "scaling-16", size: 16 * MiB, kind: "text" },
  { name: "scaling-24", size: 24 * MiB, kind: "text" },
];
const patterns = {
  text: Buffer.from("Smart Storage lossless UTF-8 fixture. café 雲\n"),
  csv: Buffer.from("1,example,42,true\n2,example,43,false\n"),
  json: Buffer.from('{"id":1,"active":true,"message":"repeated fixture"}\n'),
};
export async function generate(spec, folder) {
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, spec.name + ".bin");
  const handle = await fs.open(target, "w");
  let seed = 0x12345678;
  const sampleStarts = [0, 1, 2, 3].map((i) =>
    Math.floor((i * (spec.size - 65536)) / 3),
  );
  try {
    for (let offset = 0; offset < spec.size; offset += 65536) {
      const bytes = Buffer.alloc(Math.min(65536, spec.size - offset));
      const pattern = patterns[spec.kind] ?? patterns.text;
      for (let i = 0; i < bytes.length; i++) {
        const position = offset + i;
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const inSample = sampleStarts.some(
          (s) => position >= s && position < s + 65536,
        );
        const inCompressibleSample = [sampleStarts[0], sampleStarts[2]].some(
          (s) => position >= s && position < s + 65536,
        );
        const random =
          ["random", "compressed"].includes(spec.kind) ||
          (spec.kind === "mixed" && position >= 8 * MiB) ||
          (spec.kind === "false-negative" && inSample) ||
          (spec.kind === "false-positive" && !inCompressibleSample);
        bytes[i] = random ? seed & 255 : pattern[position % pattern.length];
      }
      await handle.write(bytes);
    }
  } finally {
    await handle.close();
  }
  if (spec.kind === "compressed") {
    const zipped = target + ".gz";
    await pipeline(
      createReadStream(target),
      createGzip(),
      createWriteStream(zipped),
    );
    // Both are synthetic files under the known cache directory; no deletion needed.
    return {
      ...spec,
      path: zipped,
      size: (await fs.stat(zipped)).size,
      sha256: await digest(zipped),
    };
  }
  return { ...spec, path: target, sha256: await digest(target) };
}
export async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
