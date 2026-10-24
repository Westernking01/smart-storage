import fs from "node:fs/promises";
const MiB = 1024 * 1024;
const report = JSON.parse(
  await fs.readFile(".cache/compression-spike/results.json", "utf8"),
);
if (!report.complete || report.failures.length)
  throw Error("Cannot publish incomplete/failed evidence");
function stats(values) {
  if (!values.length)
    return { samples: 0, min: null, median: null, p95: null, max: null };
  const a = values.toSorted((a, b) => a - b);
  return {
    samples: a.length,
    min: a[0],
    median: a[Math.floor(a.length / 2)],
    p95: a[Math.floor(a.length * 0.95)],
    max: a.at(-1),
  };
}
const rows = report.benchmarks.map((b) => {
  const runs = b.runs.map((r) => ({
    preparation: r.encoded,
    restoration: r.restored,
    mainThreadTimerGaps: stats(r.mainTimerGapsMs),
    mainThreadHeapBytes: stats(r.mainHeapBytes),
  }));
  const first = runs[0].preparation;
  return {
    fixture: b.fixture,
    originalBytes: b.originalBytes,
    sha256: first.manifest.originalSha256,
    blockSize: first.manifest.blockSize,
    sampling: b.sampling ?? null,
    payloadBytes: first.encodedPayload,
    estimatedMetadataBytes: first.manifestOverhead,
    payloadSavings: b.originalBytes
      ? 1 - first.encodedPayload / b.originalBytes
      : null,
    estimatedTotalStorageSavings: b.originalBytes
      ? 1 - (first.encodedPayload + first.manifestOverhead) / b.originalBytes
      : null,
    gzipBlocks: first.manifest.blocks.filter((b) => b.codec === "gzip").length,
    rawBlocks: first.manifest.blocks.filter((b) => b.codec === "raw").length,
    medianPrepareMs: stats(runs.map((r) => r.preparation.durationMs)).median,
    medianRestoreMs: stats(runs.map((r) => r.restoration.durationMs)).median,
    medianCompressMs: stats(runs.map((r) => r.preparation.indicators.codecMs))
      .median,
    medianDecompressMs: stats(runs.map((r) => r.restoration.indicators.codecMs))
      .median,
    trackedBufferPeak: Math.max(
      ...runs.flatMap((r) => [
        r.preparation.indicators.trackedBufferPeak,
        r.restoration.indicators.trackedBufferPeak,
      ]),
    ),
    allVerified: runs.every(
      (r) =>
        r.restoration.verified &&
        r.restoration.exactBytes &&
        r.restoration.sha256 ===
          (b.independentSha256 ?? first.manifest.originalSha256),
    ),
    runs,
  };
});
const summary = {
  environment: report.environment,
  capabilities: report.capabilities,
  warmupRuns: 1,
  measuredRuns: 3,
  complete: true,
  failures: report.failures,
  checks: report.checks,
  resourceSamples: report.resourceSamples,
  mainThreadTimerGaps: stats(
    report.benchmarks.flatMap((b) => b.runs.flatMap((r) => r.mainTimerGapsMs)),
  ),
  mainThreadHeapBytes: stats(
    report.benchmarks.flatMap((b) => b.runs.flatMap((r) => r.mainHeapBytes)),
  ),
  limitations: report.limitations,
  benchmarks: rows,
};
await fs.writeFile(
  "docs/feasibility/compression-results.json",
  JSON.stringify(summary, null, 2) + "\n",
);
const pct = (n) => (n === null ? "N/A" : (n * 100).toFixed(2) + "%");
let bytes =
  "| Fixture / block | Original B | Payload B | Metadata B¹ | Gzip:raw | Payload saved | Estimated total saved¹ | Verified |\n| --- | ---: | ---: | ---: | --- | ---: | ---: | --- |\n";
let timing =
  "| Fixture / block | Prepare ms | Restore ms | Gzip ms² | Ungzip ms² | Prepare / restore MiB/s | Tracked peak MiB³ |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n";
for (const r of rows) {
  bytes += `| ${r.fixture} / ${r.blockSize / MiB} MiB | ${r.originalBytes} | ${r.payloadBytes} | ${r.estimatedMetadataBytes} | ${r.gzipBlocks}:${r.rawBlocks} | ${pct(r.payloadSavings)} | ${pct(r.estimatedTotalStorageSavings)} | ${r.allVerified ? "Yes" : "NO"} |\n`;
  timing += `| ${r.fixture} / ${r.blockSize / MiB} MiB | ${r.medianPrepareMs.toFixed(1)} | ${r.medianRestoreMs.toFixed(1)} | ${r.medianCompressMs.toFixed(1)} | ${r.medianDecompressMs.toFixed(1)} | ${(r.originalBytes / MiB / (r.medianPrepareMs / 1000)).toFixed(2)} / ${(r.originalBytes / MiB / (r.medianRestoreMs / 1000)).toFixed(2)} | ${(r.trackedBufferPeak / MiB).toFixed(3)} |\n`;
}
await fs.writeFile(".cache/compression-spike/tables.md", bytes + "\n" + timing);
console.log(
  JSON.stringify({
    rows: rows.length,
    checks: summary.checks.length,
    timers: summary.mainThreadTimerGaps,
    heap: summary.mainThreadHeapBytes,
    peak: Math.max(...rows.map((r) => r.trackedBufferPeak)),
  }),
);
