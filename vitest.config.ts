import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Suites share one Neon database — run files strictly one at a time and
    // reseed in each file's beforeAll for isolation.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
