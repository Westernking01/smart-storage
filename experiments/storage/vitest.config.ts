import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["experiments/storage/*.test.ts"],
    maxWorkers: 1,
  },
});
