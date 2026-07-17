import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const windowsCi = process.platform === "win32" && process.env.CI === "true";

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
    // GitHub's hosted Windows disk cannot sustain two complete world databases
    // advancing concurrently; serializing there also prevents transient SQLite
    // handles from leaking into cleanup after an unrelated timeout.
    maxWorkers: windowsCi ? 1 : 2,
    // The default five seconds is too short for persistence-backed integration
    // cases on hosted Windows. Long release gates retain their explicit limits.
    testTimeout: 30_000,
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
    ],
  },
});
