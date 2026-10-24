import { defineConfig, devices } from "@playwright/test";

// Uses the already running local app, with a fresh cookie-free context per test.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "navigation.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: "http://localhost:3000", ...devices["Desktop Chrome"] },
});
