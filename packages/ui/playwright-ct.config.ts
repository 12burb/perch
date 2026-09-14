import { defineConfig, devices } from "@playwright/experimental-ct-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Playwright component tests for @perch/ui (spec §11 task 0.11): every component mounts in a real
 * Chromium, is driven by keyboard and pointer, and passes axe. `*.ct.tsx` keeps them out of `bun test`.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./src",
  testMatch: /.*\.ct\.tsx$/,
  snapshotDir: "./__snapshots__",
  timeout: 20_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    ctPort: 3100,
    ctViteConfig: { plugins: [tailwindcss()] },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
});
