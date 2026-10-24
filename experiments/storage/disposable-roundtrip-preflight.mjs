// Offline only: requires --check compilation first. No HTTPS adapter invocation.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const modulePath = fileURLToPath(
  new URL(
    "../../.cache/disposable-roundtrip-host/experiments/storage/disposable-roundtrip-executor.js",
    import.meta.url,
  ),
);
const { prepareDisposableFixture, filesystemAttemptClaims } = require(
  modulePath,
);
const fixtureDir = new URL("./disposable-roundtrip-fixture/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = await prepareDisposableFixture();
const expected = Buffer.from(
  "Disposable Smart Storage round trip.\n".repeat(128),
  "utf8",
);
assert.deepEqual(Buffer.from(fixture.source), expected);
assert.deepEqual(
  gunzipSync(fixture.encoded, { maxOutputLength: expected.length }),
  expected,
);
assert.equal(hash(expected), fixture.sourceSha256);
assert.equal(hash(fixture.encoded), fixture.encodedSha256);
assert.equal(fixture.sourceBytes, expected.length);
assert.equal(fixture.encodedBytes, fixture.encoded.length);
const manifest = {
  sourceBytes: expected.length,
  encodedBytes: fixture.encoded.length,
  sourceSha256: hash(expected),
  encodedSha256: hash(fixture.encoded),
  verification:
    "Node crypto SHA-256 and zlib bounded gunzip; independent of application codec/hash/restore",
};
if (process.argv[2] === "--prepare" && process.argv.length === 3) {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(new URL("source.bin", fixtureDir), expected, { flag: "wx" });
  await writeFile(new URL("encoded.gz", fixtureDir), fixture.encoded, {
    flag: "wx",
  });
  await writeFile(
    new URL("manifest.json", fixtureDir),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
} else {
  assert.equal(process.argv.length, 2, "No arguments except initial --prepare");
}
assert.deepEqual(await readFile(new URL("source.bin", fixtureDir)), expected);
assert.deepEqual(
  await readFile(new URL("encoded.gz", fixtureDir)),
  Buffer.from(fixture.encoded),
);
assert.deepEqual(
  JSON.parse(await readFile(new URL("manifest.json", fixtureDir), "utf8")),
  manifest,
);

// Unique scratch directory only; never consumes or cleans real target claims.
const scratch = await mkdtemp(join(tmpdir(), "ss-upload-preflight-"));
const child = (code) => {
  const result = spawnSync(
    process.execPath,
    ["-e", code, modulePath, scratch],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  const prelude = "const {filesystemAttemptClaims}=require(process.argv[1]);";
  assert.equal(
    child(
      prelude +
        'filesystemAttemptClaims(process.argv[2])("offline-restart").then(x=>console.log(x));',
    ),
    "true",
  );
  assert.equal(
    child(
      prelude +
        'filesystemAttemptClaims(process.argv[2])("offline-restart").then(x=>console.log(x));',
    ),
    "false",
  );
  // Exit abruptly after exclusive empty marker creation, before contents/sync.
  child(
    'const {openSync}=require("node:fs"); const {join}=require("node:path"); const {createHash}=require("node:crypto"); openSync(join(process.argv[2],createHash("sha256").update("offline-crash").digest("hex")+".claim"),"wx"); process.exit(0);',
  );
  assert.equal(
    child(
      prelude +
        'filesystemAttemptClaims(process.argv[2])("offline-crash").then(x=>console.log(x));',
    ),
    "false",
  );
  assert.deepEqual(
    (
      await Promise.all([
        filesystemAttemptClaims(scratch)("offline-race"),
        filesystemAttemptClaims(scratch)("offline-race"),
      ])
    ).sort(),
    [false, true],
  );
} finally {
  await rm(scratch, { recursive: true });
}
console.log(
  `PASS independent retained fixture (${manifest.sourceBytes} source / ${manifest.encodedBytes} gzip bytes); fresh-process replay, abrupt empty-marker exit and race fencing. Power loss NOT qualified.`,
);
