#!/usr/bin/env bun
/**
 * Playwright's web server: builds apps/web (skip with E2E_SKIP_BUILD=1) and runs `perch dev` (laptop
 * mode: api, the built client, and the in-process runner on PGlite) on port 3999 with a throwaway
 * data dir, so specs exercise exactly what a laptop user runs.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const port = process.env.E2E_PORT ?? "3999";

if (!process.env.E2E_SKIP_BUILD) {
  const build = Bun.spawnSync(["bun", "run", "--filter", "@perch/web", "build"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) process.exit(build.exitCode);
}

const dataDir = mkdtempSync(join(tmpdir(), "perch-e2e-"));
const api = Bun.spawn(
  [
    "bun",
    "apps/cli/src/index.ts",
    "dev",
    "--port",
    port,
    "--host",
    "127.0.0.1",
    "--public-url",
    `http://localhost:${port}`,
    "--data-dir",
    dataDir,
    "--log-level",
    process.env.PERCH_LOG_LEVEL ?? "warn",
  ],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // Sessions run on the fake ACP agent of the runner's tests (task 1.12's spec needs no key).
      PERCH_ACP_AGENTS: JSON.stringify({
        fake: {
          name: "Fake Agent",
          command: process.execPath,
          args: [resolve(root, "apps/runner/test/fixtures/acp-agent.ts")],
        },
      }),
      PERCH_ACP_AGENT: "fake",
    },
  },
);

const stop = () => api.kill();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// The wizard is one-time per database: complete it here (as e2e/00-setup.e2e.ts would through the UI)
// unless E2E_SETUP=wizard leaves it to that spec, so every other spec starts from a set-up instance.
if (process.env.E2E_SETUP !== "wizard") {
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  const res = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      admin: {
        name: "E2E Admin",
        email: "admin@perch.test",
        password: "admin-passphrase-for-tests",
      },
      workspace: { name: "Admin" },
      public_url: base,
      telemetry: false,
    }),
  });
  if (res.status !== 201 && res.status !== 409) {
    console.error(`e2e setup failed: ${res.status} ${await res.text()}`);
    api.kill();
    process.exit(1);
  }
}

process.exit(await api.exited);
