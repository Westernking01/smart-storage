import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { serve } from "./server.mjs";
import { generate, specs } from "./fixtures.mjs";

const MiB = 1024 * 1024;
const root = path.resolve(".cache/compression-spike");
const smallOnly = process.argv.includes("--small");
const resultsPath = path.join(
  root,
  smallOnly ? "small-results.json" : "results.json",
);
const disk = () => {
  const s = statfsSync(".");
  return s.bavail * s.bsize;
};
const environment = {
  recordedAt: new Date().toISOString(),
  node: process.version,
  os: os.release(),
  arch: os.arch(),
  cpu: os.cpus()[0].model,
  physicalMemory: os.totalmem(),
  initialFreeMemory: os.freemem(),
  initialDiskFree: disk(),
  noble: JSON.parse(
    await fs.readFile("node_modules/@noble/hashes/package.json", "utf8"),
  ).version,
  playwright: JSON.parse(
    await fs.readFile("node_modules/@playwright/test/package.json", "utf8"),
  ).version,
};
assert.equal(environment.noble, "2.4.0");
assert.ok(
  environment.initialDiskFree > 512 * MiB,
  "At least 512 MiB free disk required",
);
const { server, url } = await serve();
let browser;
const report = {
  environment,
  capabilities: {},
  benchmarks: [],
  checks: [],
  failures: [],
  resourceSamples: [],
  limitations: [
    "Synthetic files only; <100 MiB",
    "Worker/native/process allocations are not fully observable",
    "Three measured runs after warm-up; no representative p95",
    "Only the installed Chromium engine was tested",
  ],
};
const save = async () => {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(report, null, 2));
};
const checked = (name, details = {}) => {
  report.checks.push({ name, passed: true, ...details });
  console.log("PASS", name);
};
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--enable-precise-memory-info"],
  });
  report.environment.browser = browser.version();
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes('"opfs":true'),
  );
  report.capabilities = await page.evaluate(() => window.spike.call("init"));
  assert.deepEqual(report.capabilities, {
    compression: true,
    decompression: true,
    worker: true,
    opfs: true,
  });
  checked("native gzip/decompression and OPFS inside module worker");
  const vectors = await page.evaluate(() => window.spike.call("vectors"));
  const texts = [
    "",
    "abc",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "a".repeat(1000000),
  ];
  const known = [
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  ];
  assert.deepEqual(vectors, known);
  assert.deepEqual(
    vectors,
    texts.map((t) => createHash("sha256").update(t).digest("hex")),
  );
  checked(
    "four incremental SHA-256 known vectors versus independent Node crypto",
  );
  const transfer = await page.evaluate(async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const promise = window.spike.call("transfer", { buffer }, [buffer]);
    const detached = buffer.byteLength === 0;
    const result = await promise;
    return { detached, bytes: Array.from(new Uint8Array(result.buffer)) };
  });
  assert.deepEqual(transfer, { detached: true, bytes: [1, 2, 3, 4] });
  checked("transferable ownership detaches and round-trips buffer");

  const fixtures = new Map();
  for (const spec of specs.filter((s) => !smallOnly || s.size <= MiB)) {
    const resource = {
      fixture: spec.name,
      freeMemory: os.freemem(),
      diskFree: disk(),
    };
    report.resourceSamples.push(resource);
    // Deliberately conservative finite progression; never fall through to very large runs.
    if (resource.diskFree < 512 * MiB || resource.freeMemory < 96 * MiB)
      throw Error(
        `Resource gate before ${spec.name}: ${JSON.stringify(resource)}`,
      );
    const fixture = await generate(spec, path.join(root, "fixtures"));
    fixtures.set(spec.name, fixture);
    await page.locator("#file").setInputFiles(fixture.path);
    const sampling = await page.evaluate(() =>
      window.spike.call("sample", {
        file: document.querySelector("#file").files[0],
      }),
    );
    assert.ok(sampling.sampledBytes <= 256 * 1024);
    const runs = [];
    for (let iteration = -1; iteration < 3; iteration++) {
      const result = await page.evaluate(
        async ({ blockSize }) => {
          const h = window.spike;
          h.resetMeasurements();
          const encoded = await h.call("prepare", {
            file: document.querySelector("#file").files[0],
            blockSize,
          });
          const restored = await h.call("restore");
          return {
            encoded,
            restored,
            events: h.events,
            mainTimerGapsMs: h.gaps,
            mainHeapBytes: h.heap,
          };
        },
        { blockSize: 8 * MiB },
      );
      assert.equal(result.encoded.manifest.originalSha256, fixture.sha256);
      assert.equal(result.restored.sha256, fixture.sha256);
      assert.equal(result.restored.originalBytes, fixture.size);
      assert.equal(result.restored.verified, true);
      assert.equal(result.restored.exactBytes, true);
      assert.equal(result.encoded.indicators.liveBlocksPeak, 1);
      for (const phase of ["prepare", "restore"]) {
        const events = result.events.filter(
          (e) => e.event === "progress" && e.phase === phase,
        );
        assert.equal(events.at(-1).originalBytes, fixture.size);
        for (let i = 1; i < events.length; i++)
          assert.ok(events[i].originalBytes >= events[i - 1].originalBytes);
      }
      const actualSavings = fixture.size
        ? 1 - result.encoded.encodedPayload / fixture.size
        : null;
      if (iteration >= 0) runs.push({ ...result, actualSavings });
    }
    const row = {
      fixture: spec.name,
      originalBytes: fixture.size,
      independentSha256: fixture.sha256,
      sampling,
      runs,
    };
    report.benchmarks.push(row);
    checked(`round-trip/${spec.name}`, {
      runs: 3,
      originalBytes: fixture.size,
      encodedPayload: runs[0].encoded.encodedPayload,
    });
    await page.evaluate(() => window.spike.call("cleanup"));
    await save();
  }
  // Independent gzip decoder comparison on a bounded captured block.
  await page.locator("#file").setInputFiles(fixtures.get("repetitive").path);
  await page.evaluate(() =>
    window.spike.call("prepare", {
      file: document.querySelector("#file").files[0],
      blockSize: 8 * 1024 * 1024,
    }),
  );
  const capture = await page.evaluate(() => window.spike.call("capture"));
  const decoded = gunzipSync(Buffer.from(capture.bytes));
  assert.equal(
    createHash("sha256").update(decoded).digest("hex"),
    capture.descriptor.originalSha256,
  );
  checked("Node zlib independently decodes browser gzip");

  const corruption = [
    "raw-corrupt",
    "gzip-corrupt",
    "gzip-corrupt-rehashed",
    "gzip-truncated-rehashed",
    "missing",
    "missing-object",
    "reordered",
    "original-length",
    "encoded-length",
    "unsupported-codec",
    "unsupported-version",
    "original-hash",
    "whole-hash",
    "excessive-output",
  ];
  for (const kind of corruption) {
    const fixture = fixtures.get(
      kind === "raw-corrupt" ? "seeded-random" : "repetitive",
    );
    await page.locator("#file").setInputFiles(fixture.path);
    const rejection = await page.evaluate(async (kind) => {
      const h = window.spike;
      const prepared = await h.call("prepare", {
        file: document.querySelector("#file").files[0],
        blockSize: 65536,
      });
      let m = prepared.manifest;
      if (kind.includes("corrupt") || kind.includes("truncated"))
        m = await h.call("mutate", {
          rehash: kind.includes("rehashed"),
          truncate: kind.includes("truncated"),
        });
      if (kind === "missing") m.blocks.pop();
      if (kind === "missing-object") await h.call("drop");
      if (kind === "reordered")
        [m.blocks[0], m.blocks[1]] = [m.blocks[1], m.blocks[0]];
      if (kind === "original-length") m.blocks[0].originalBytes--;
      if (kind === "encoded-length") m.blocks[0].encodedBytes++;
      if (kind === "unsupported-codec") m.blocks[0].codec = "zip";
      if (kind === "unsupported-version") m.version = 99;
      if (kind === "original-hash") m.blocks[0].originalSha256 = "0".repeat(64);
      if (kind === "whole-hash") m.originalSha256 = "0".repeat(64);
      if (kind === "excessive-output") {
        m.blocks = [m.blocks[0]];
        m.originalBytes = 32;
        m.blocks[0].originalBytes = 32;
      }
      let error;
      try {
        await h.call("restore", { manifest: m });
      } catch (e) {
        error = e.message;
      }
      // A failed job must never leave a completed restored artifact.
      const stats = await h.call("stats");
      const count = m.blocks.length;
      await h.call("cleanup");
      const after = await h.call("stats");
      return { error, stats, count, after };
    }, kind);
    assert.ok(rejection.error, `${kind} must fail`);
    assert.ok(
      !rejection.stats.names.includes("restored"),
      "No partial output labeled complete",
    );
    assert.equal(rejection.after.count, 0);
    checked(`reject/${kind}`, { error: rejection.error });
  }
  if (!smallOnly) {
    for (const name of ["mixed", "scaling-16", "scaling-24"]) {
      await page.locator("#file").setInputFiles(fixtures.get(name).path);
      const runs = [];
      for (let i = -1; i < 3; i++) {
        const r = await page.evaluate(async () => {
          const h = window.spike;
          h.resetMeasurements();
          const encoded = await h.call("prepare", {
            file: document.querySelector("#file").files[0],
            blockSize: 2 * 1024 * 1024,
          });
          const restored = await h.call("restore");
          return {
            encoded,
            restored,
            mainTimerGapsMs: h.gaps,
            mainHeapBytes: h.heap,
          };
        });
        assert.equal(r.restored.sha256, fixtures.get(name).sha256);
        if (i >= 0) runs.push(r);
      }
      report.benchmarks.push({
        fixture: name + "/2MiB",
        originalBytes: fixtures.get(name).size,
        runs,
      });
      checked(`smaller-block/${name}`);
      await save();
    }
    await page
      .locator("#file")
      .setInputFiles(fixtures.get("boundary-plus").path);
    const backpressure = await page.evaluate(async () => {
      const h = window.spike;
      h.resetMeasurements();
      const result = await h.call("prepare", {
        file: document.querySelector("#file").files[0],
        blockSize: 8 * 1024 * 1024,
        sinkDelay: 100,
      });
      return { events: h.events, indicators: result.indicators };
    });
    assert.ok(backpressure.indicators.sinkMs >= 200);
    assert.equal(backpressure.indicators.liveBlocksPeak, 1);
    const firstProgress = backpressure.events.findIndex(
      (e) => e.event === "progress" && e.index === 0,
    );
    const secondCompress = backpressure.events.findIndex(
      (e) => e.event === "phase" && e.index === 1,
    );
    assert.ok(secondCompress > firstProgress);
    checked("slow sink backpressure releases each block before next", {
      sinkMs: backpressure.indicators.sinkMs,
    });
    await page
      .locator("#file")
      .setInputFiles(fixtures.get("seeded-random").path);
    const cancel = await page.evaluate(async () => {
      const h = window.spike;
      let sent;
      let pingMs;
      let busy;
      h.onEvent = (e) => {
        if (e.event === "phase" && sent === undefined) {
          sent = performance.now();
          h.cancel();
        }
      };
      const result = h.call("prepare", {
        file: document.querySelector("#file").files[0],
        blockSize: 8 * 1024 * 1024,
      });
      result.catch(() => {}); // Observe rejection while concurrent control messages settle.
      const pingStart = performance.now();
      await h.call("ping");
      pingMs = performance.now() - pingStart;
      try {
        await h.call("sample", {
          file: document.querySelector("#file").files[0],
        });
      } catch (e) {
        busy = e.message;
      }
      let error;
      try {
        await result;
      } catch (e) {
        error = e.name;
      }
      h.onEvent = undefined;
      return {
        error,
        busy,
        pingMs,
        latencyMs: performance.now() - sent,
        stats: await h.call("stats"),
      };
    });
    assert.equal(cancel.error, "AbortError");
    assert.equal(cancel.busy, "busy");
    assert.equal(cancel.stats.count, 0);
    assert.ok(cancel.latencyMs < 1000);
    checked(
      "cancellation during codec processing, busy rejection, worker ping and cleanup",
      cancel,
    );
    await page.locator("#file").setInputFiles(fixtures.get("scaling-16").path);
    const restoreCancel = await page.evaluate(async () => {
      const h = window.spike;
      await h.call("prepare", {
        file: document.querySelector("#file").files[0],
        blockSize: 8 * 1024 * 1024,
      });
      let sent;
      h.onEvent = (e) => {
        if (
          e.event === "progress" &&
          e.phase === "restore" &&
          sent === undefined
        ) {
          sent = performance.now();
          h.cancel();
        }
      };
      let error;
      try {
        await h.call("restore");
      } catch (e) {
        error = e.name;
      }
      h.onEvent = undefined;
      const latencyMs = performance.now() - sent;
      const stats = await h.call("stats");
      await h.call("cleanup");
      return { error, latencyMs, stats, after: await h.call("stats") };
    });
    assert.equal(restoreCancel.error, "AbortError");
    assert.ok(!restoreCancel.stats.names.includes("restored"));
    assert.equal(restoreCancel.after.count, 0);
    assert.ok(restoreCancel.latencyMs < 1000);
    checked(
      "restoration cancellation aborts and removes partial output",
      restoreCancel,
    );
    await page
      .locator("#file")
      .setInputFiles(fixtures.get("boundary-plus").path);
    const termination = await page.evaluate(async () => {
      const h = window.spike;
      h.onEvent = (e) => {
        if (e.event === "phase" && e.index === 1) h.close();
      };
      let error;
      try {
        await h.call("prepare", {
          file: document.querySelector("#file").files[0],
          blockSize: 8 * 1024 * 1024,
        });
      } catch (e) {
        error = e.message;
      }
      const { Harness } = await import("/client.js");
      window.spike = new Harness();
      await window.spike.call("init");
      return { error, stats: await window.spike.call("stats") };
    });
    assert.equal(termination.error, "Worker terminated");
    assert.equal(termination.stats.count, 0);
    checked(
      "forced termination settles pending promise and restart cleans artifacts",
    );
  }
  assert.deepEqual(pageErrors, []);
  checked("no browser page errors");
  await page.evaluate(async () => {
    await window.spike.call("cleanup");
    window.spike.close();
  });
  await context.close();
  report.complete = true;
  await save();
  console.log(
    JSON.stringify({
      resultsPath,
      browser: report.environment.browser,
      benchmarks: report.benchmarks.length,
      checks: report.checks.length,
      complete: true,
    }),
  );
} catch (error) {
  report.failures.push({ message: String(error), stack: error.stack });
  report.complete = false;
  await save();
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
