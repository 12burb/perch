import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the laptop-mode server (PGlite in memory) that scripts/e2e-server.ts
 * starts on port 3999. PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a preinstalled Chromium when the
 * Playwright download is unavailable (the browser revision must be compatible with the pinned version).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
/**
 * The app answers on `perch.localhost` and previews on `<port>--<slug>.perch.localhost`: previews
 * are then same-site with Perch, so the cookie that lets a member into a framed preview survives
 * (ADR-0084), and every `.localhost` name is both resolved and trusted by the browser — a secure
 * context, which passkeys and WebCrypto need. It is the layout the docs recommend for a real
 * instance, with `localhost` standing in for the domain.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://perch.localhost:3999";
/**
 * Previews get a hostname each (spec §5.6), and the preview spec needs those names to resolve to
 * the same server: Chromium maps them itself rather than the machine needing DNS or /etc/hosts.
 */
// Everything this browser talks to is on this machine; an ambient proxy would swallow the
// WebSocket upgrades (HMR's and Perch's own), which is not what a real browser would do here.
const launchArgs = ["--no-proxy-server"];

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
    launchOptions: { args: launchArgs, ...(executablePath ? { executablePath } : {}) },
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /(phase1|phase2|push)\.e2e\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testIgnore: /(phase1|phase2|push)\.e2e\.ts$/,
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    // Web push (task 2.3) needs a browser that has the Push API, and the headless shell Playwright
    // runs by default does not have one — it is a stripped build. `channel: "chromium"` asks for
    // the full browser in its new headless mode, which is also what a phone would be running.
    {
      name: "push",
      testMatch: /push\.e2e\.ts$/,
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, channel: "chromium" },
    },
    // Phase 1's exit criterion, four times over (task 1.22): the same loop on a paid key, on
    // Ollama, through OpenCode, and through ACP. At a phone's viewport, which is where the
    // criterion says it has to work.
    ...(["key", "ollama", "opencode", "acp"] as const).map((lane) => ({
      name: `phase1-${lane}`,
      testMatch: /phase1\.e2e\.ts$/,
      metadata: { lane },
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    })),
    // Phase 2's exit criterion, once (task 2.21): three people in three browsers, and a phone for
    // the inbox. The spec opens the phone's context itself, so this one runs on a laptop.
    {
      name: "phase2",
      testMatch: /phase2\.e2e\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "bun scripts/e2e-server.ts",
    // Node does not have Chromium's resolver rules, so the readiness check uses the address.
    url: `http://127.0.0.1:${new URL(baseURL).port || 80}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
