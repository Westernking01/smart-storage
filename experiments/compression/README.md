# Browser compression feasibility experiment

Task 1.3B proof of concept only. No application imports this directory. No upload, provider, authentication or production manifest implementation. Remove this directory and generated evidence/cache to remove the experiment.

From the project root:

```text
node node_modules/vitest/vitest.mjs run --config experiments/compression/vitest.config.ts
node experiments/compression/run.mjs --small
node experiments/compression/run.mjs
```

The runner uses the installed Playwright Chromium; an explicitly reviewed binary can be selected with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. It starts a loopback-only server on an ephemeral port, serves transpiled experimental TypeScript and the installed noble ESM files, runs one browser/worker, then closes them. No new bundler or package is installed. `npm run typecheck` checks experimental TypeScript through the existing strict project configuration; root ESLint/Prettier also cover the experiment. The production build remains unchanged.

The harness uses a real File selected by Playwright. Node generates synthetic fixtures incrementally in 64 KiB chunks and hashes them independently. Worker File.slice reads are bounded by the selected block size; encoded blocks are sequentially written to an experiment-only OPFS directory before the next block is read. All processing results, inputs and restored outputs stay local. Digest evidence contains synthetic fixtures only. This is not a durable upload-staging implementation.

Every block attempts native gzip with a candidate cap floor(original bytes × 0.98). Cap overflow cancels the candidate and selects raw. Empty input uses one empty raw block. Hash updates consume the original bytes in order, never concatenated block hashes. Restoration validates structural limits, encoded hash/length, original block hash/length and whole-file hash/length before closing its provisional sink. Independent byte comparison is an additional test-only read/buffer; production would not have the original source during download.

Sampling calibrates up to four nonoverlapping 64 KiB ranges, at most 256 KiB total. Its >5% estimate is recorded but deliberately does not skip encoding in the calibration runs. The chosen payload is the actual gzip/raw result; sampled estimates are not measured savings. Two adversarial fixtures expose incorrect predictions. Serialized experimental descriptor JSON bytes estimate metadata overhead; they do not predict a canonical production manifest or provider object/request overhead.

Warm-up: one discarded round trip per fixture/block size; measured repetitions: three. Timings include conservative cooperative hash yields, disk writes and test-only source comparison. Codec/hash/sink indicators are separate; throughput is original bytes divided by total preparation/restoration time. Timer gaps are 20 ms main-thread heartbeat observations, not representative user-interaction p95. The tracked-buffer ledger counts explicitly live backing buffers and observed output chunks; native codecs, internal stream queues, GC-retained buffers, browser processes and OS caches are not fully observable. Worker heap telemetry may be unavailable. No constant-memory or desktop/mobile budget claim follows.

Resource gates: at least 512 MiB free disk and 96 MiB host free RAM before each fixture; fixtures progress from empty to at most 24 MiB. The experimental source cap is 32 MiB and descriptor cap 128. Do not raise these caps or run 100 MiB+ fixtures without explicit approval. Node/browser measurements and complete assertion evidence are written to ignored `.cache/compression-spike/`. OPFS artifacts are removed on completion/cancellation; worker restart removes only deterministic artifacts in its own namespace after forced termination. A crashed browser may need another harness run to clean that namespace.

See [the report](../../docs/feasibility/compression-spike.md) for executed results, failures/corrections and pending browser/device/provider gates. Production ADRs remain proposed. Stop after Task 1.3B; Task 1.4 requires approval.
