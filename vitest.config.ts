import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@worldtangle/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
      "@worldtangle/engine": fileURLToPath(
        new URL("./packages/engine/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // Keep the SQLite-heavy integration and 360-tick gate suites below the
    // filesystem saturation point on both developer machines and CI runners.
    // Two workers keep the CPU-heavy 360-tick Phase 3/4 gates responsive
    // enough for Vitest's worker RPC on Windows as the suite grows.
    maxWorkers: 2,
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
    ],
  },
});
