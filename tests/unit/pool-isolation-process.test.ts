import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const fakeDriver = `
import { Client, Pool } from 'pg';
let created = 0;
class OfflineClient extends Client {
  constructor(options) { super(options); this.index = ++created; }
  connect(callback) { process.nextTick(() => callback(this.index === 2 ? Error('PRIVATE_DRIVER_DIAGNOSTIC') : null)); }
  end(callback) { if (callback) process.nextTick(callback); else return Promise.resolve(); }
}
`;
it("reproduces the former uncaught constructor exception using real pg-pool queue callbacks", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      fakeDriver +
        `
let constructions = 0;
class OldBounded extends OfflineClient {
  constructor(options) { if (++constructions > 2) throw Error('CONNECTION_LIMIT'); super(options); }
}
const pool = new Pool({ Client: OldBounded, max: 2 });
// Third request queues while the second connection is still being established.
await Promise.allSettled([pool.connect(), pool.connect(), pool.connect()]);
`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CONNECTION_LIMIT");
  expect(result.stderr).toContain("_pulseQueue");
});
it("compiled qualification contains queue failure, shuts down and exits with a sanitized line", () => {
  const check = spawnSync(
    process.execPath,
    ["scripts/qualify-pool-isolation.mjs", "--check"],
    { encoding: "utf8", timeout: 20000 },
  );
  expect(check.status).toBe(0);
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--input-type=module",
      "--eval",
      fakeDriver +
        `
import { qualificationPool } from './.cache/pool-isolation-qualification/lifecycle.mjs';
import { poolFailureLine } from './.cache/pool-isolation-qualification/runner.mjs';
const pool = qualificationPool({ connectionTimeoutMillis: 1000 }, OfflineClient);
try {
  const results = await Promise.allSettled([pool.connect(), pool.connect(), pool.connect()]);
  for (const result of results) if (result.status === 'fulfilled') result.value.release(true);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
} catch (error) {
  console.error(poolFailureLine(error));
  process.exitCode = 1;
} finally { await pool.end(); }
`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe("FAIL: DATABASE_CONNECT_FAILED");
});

it("PowerShell invalid-mode failure emits a fixed record without a stack", () => {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-File", "scripts/qualify-pool-isolation.ps1"],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe("FAIL: POOL_LIFECYCLE_FAILED");
  expect(result.stderr).toBe("");
});
