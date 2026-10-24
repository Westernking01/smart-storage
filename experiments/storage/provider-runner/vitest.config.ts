import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["experiments/storage/provider-runner/*.test.ts"],
    maxWorkers: 1,
  },
});
