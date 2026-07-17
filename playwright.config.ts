import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 4_173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  retries: process.env["CI"] === undefined ? 0 : 1,
  workers: 1,
  reporter: process.env["CI"] === undefined
    ? "line"
    : [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
  }],
  webServer: {
    command: "pnpm start",
    url: `${baseURL}/api/v1/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      WORLDTANGLE_BIND: "127.0.0.1",
      WORLDTANGLE_PORT: String(port),
      WORLDTANGLE_DATA_DIR: join(tmpdir(), `worldtangle-playwright-${process.pid}`),
      WORLDTANGLE_TICK_INTERVAL_MS: "200",
      WORLDTANGLE_SNAPSHOT_INTERVAL_TICKS: "30",
    },
  },
});
