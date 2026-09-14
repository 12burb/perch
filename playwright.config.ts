import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the laptop-mode server (PGlite in memory) that scripts/e2e-server.ts
 * starts on port 3999. PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a preinstalled Chromium when the
 * Playwright download is unavailable (the browser revision must be compatible with the pinned version).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3999";

export default defineConfig({
  testDir: "e2e",
  // *.e2e.ts keeps Playwright specs out of `bun test`, which discovers *.spec.* and *.test.* files.
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "bun scripts/e2e-server.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
