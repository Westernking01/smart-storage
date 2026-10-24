import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["experiments/compression/*.test.ts"],
    maxWorkers: 1,
  },
});
