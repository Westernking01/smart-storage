import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "vite";
import config from "../../vitest.config";

it("does not load environment files in the offline unit or browser harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "smart-storage-env-test-"));
  try {
    // Synthetic public sentinel only; never inspect repository environment files.
    await writeFile(
      join(root, ".env.local"),
      "VITE_OFFLINE_ENV_SENTINEL=must-not-load\n",
    );
    const resolved = await resolveConfig(
      { ...config, root, configFile: false },
      "build",
    );
    expect(resolved.envDir).toBe(false);
    expect(resolved.env).not.toHaveProperty("VITE_OFFLINE_ENV_SENTINEL");
    const browser = await readFile(
      new URL("./transfer-browser-lifecycle.test.ts", import.meta.url),
      "utf8",
    );
    expect(browser).toMatch(/configFile: false,\s+envDir: false/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
