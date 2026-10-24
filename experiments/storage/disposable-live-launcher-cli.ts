import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { maskedInput } from "./probe-auth-host-cli";
import { launchDisposableRoundTrip } from "./disposable-live-launcher";

if (require.main === module) {
  void (async () => {
    const mode = process.argv[2];
    if (
      process.argv.length !== 3 ||
      !["--preflight", "--execute"].includes(mode) ||
      process.env.NODE_OPTIONS ||
      process.execArgv.some((v) => /inspect|debug/.test(v)) ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY
    )
      throw Error("PRIVATE_TERMINAL_REQUIRED");
    const path = await maskedInput(
      "Absolute path to reviewed NONSECRET evidence JSON (hidden): ",
    );
    if (resolve(path) !== path) throw Error("ABSOLUTE_PATH_REQUIRED");
    const file = await readFile(path);
    if (file.length > 16384) throw Error("EVIDENCE_LIMIT");
    const fixture = resolve(
      __dirname,
      "../../../../experiments/storage/disposable-roundtrip-fixture",
    );
    const source = new Uint8Array(
      await readFile(resolve(fixture, "source.bin")),
    );
    const encoded = new Uint8Array(
      await readFile(resolve(fixture, "encoded.gz")),
    );
    const manifest = JSON.parse(
      await readFile(resolve(fixture, "manifest.json"), "utf8"),
    );
    const hash = (value: Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    if (
      !Buffer.from(source).equals(
        Buffer.from("Disposable Smart Storage round trip.\n".repeat(128)),
      ) ||
      source.length !== manifest.sourceBytes ||
      encoded.length !== manifest.encodedBytes ||
      hash(source) !== manifest.sourceSha256 ||
      hash(encoded) !== manifest.encodedSha256 ||
      !gunzipSync(encoded, { maxOutputLength: source.length }).equals(
        Buffer.from(source),
      )
    )
      throw Error("RETAINED_FIXTURE_INTEGRITY");
    await launchDisposableRoundTrip({
      mode: mode as "--preflight" | "--execute",
      evidence: JSON.parse(file.toString("utf8")),
      source,
      encoded,
      hidden: maskedInput,
      transport: fetch,
    });
    process.stdout.write(
      mode === "--preflight"
        ? "PASS: read-only preflight; no claims or Storage mutation. Session discarded.\n"
        : "PASS: one compressed upload/download verified. Retain object and claims.\n",
    );
  })().catch(() => {
    process.stderr.write(
      "BLOCKED: cancelled, unqualified, rejected or uncertain. Stop; retain all claims and objects. No automatic retry.\n",
    );
    process.exitCode = 1;
  });
}
