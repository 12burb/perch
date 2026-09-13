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
process.exit(await api.exited);
