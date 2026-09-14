#!/usr/bin/env bun
/**
 * Playwright's web server: builds apps/web (skip with E2E_SKIP_BUILD=1) and runs the api in laptop
 * mode on port 3999 with PGlite in memory and a throwaway data dir, serving the built client.
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
const api = Bun.spawn(["bun", "apps/api/src/index.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    PORT: port,
    DATABASE_URL: "pglite://memory",
    PERCH_PUBLIC_URL: `http://localhost:${port}`,
    PERCH_DATA_DIR: dataDir,
    PERCH_LOG_LEVEL: process.env.PERCH_LOG_LEVEL ?? "warn",
  },
});

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
