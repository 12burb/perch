/**
 * Laptop mode as a function (spec §2): api + web + the in-process runner on PGlite under a data
 * directory. `perch dev` calls it and waits for a signal; the desktop app (apps/desktop, ADR-0063)
 * calls it and keeps the process for its window.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { boot } from "@perch/api/boot";
import { loadEnv } from "@perch/api/env";
import { serve } from "@perch/api/server";
import { createInProcessRunner } from "@perch/runner";
import { dataDirFrom, laptopLayout, webDistDir } from "./paths.ts";
import { pgliteRuntime } from "./pglite-runtime.ts";
import { webAssets } from "./web-assets.gen.ts";

export { dataDirFrom } from "./paths.ts";

export type LaptopOptions = {
  /** The --data-dir flag; unset means PERCH_DATA_DIR or ~/.perch. */
  dataDir?: string;
  /** Default PORT or 3000; 0 asks the OS for a free port (smoke tests only: the public URL cannot follow). */
  port?: number;
  /** Address to bind (default 127.0.0.1). */
  host?: string;
  /** PERCH_PUBLIC_URL when it differs from http://<host>:<port>. */
  publicUrl?: string;
  /** PERCH_PREVIEW_DOMAIN: previews get a hostname each instead of a path (spec §5.6). */
  previewDomain?: string;
  logLevel?: string;
};

export type Laptop = {
  url: string;
  dataDir: string;
  runnerName: string;
  /** Stops the jobs worker and the server; idempotent. */
  stop(): Promise<void>;
};

/** A port from a flag or the environment; null when it is not a port. */
export function laptopPort(value: string | number | undefined): number | null {
  const port = Number(value ?? process.env.PORT ?? 3000);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

export async function startLaptop(options: LaptopOptions = {}): Promise<Laptop> {
  const layout = laptopLayout(dataDirFrom(options.dataDir));
  mkdirSync(layout.files, { recursive: true });
  const host = options.host ?? "127.0.0.1";
  const requestedPort = laptopPort(options.port);
  if (requestedPort === null) throw new Error(`bad port: ${options.port}`);
  // Port 0 asks the OS for a free port; the env needs a real number, so PERCH_PUBLIC_URL is set after.
  const envPort = requestedPort === 0 ? 3000 : requestedPort;
  const publicUrl =
    options.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${envPort}`;
  const env = loadEnv({
    ...process.env,
    DATABASE_URL: layout.databaseUrl,
    PERCH_DATA_DIR: layout.dataDir,
    PERCH_FILES_DIR: layout.files,
    PERCH_PUBLIC_URL: publicUrl,
    PERCH_RUNNER_MODE: "inprocess",
    PORT: String(envPort),
    HOST: host,
    ...(options.previewDomain ? { PERCH_PREVIEW_DOMAIN: options.previewDomain } : {}),
    ...(options.logLevel ? { PERCH_LOG_LEVEL: options.logLevel } : {}),
  });
  const webDist = webDistDir();
  const embedded = Object.keys(webAssets).length > 0;
  if (!existsSync(join(webDist, "index.html")) && !embedded) {
    console.error(`no web build at ${webDist}; run \`bun run --filter @perch/web build\` first`);
  }
  const booted = await boot({
    env,
    app: { webDist, ...(embedded ? { webAssets } : {}) },
    pglite: await pgliteRuntime(),
  });
  const runner = createInProcessRunner({ projectsDir: join(layout.dataDir, "projects") });
  booted.runners.attach(runner);
  runner.heartbeat();
  const running = serve(booted, { port: requestedPort, hostname: host });
  const url = requestedPort === 0 ? running.url : publicUrl;
  if (requestedPort === 0) {
    // The public URL must carry the real port for passkeys and links: rebind is not possible after
    // boot, so a random port is for smoke tests only.
    booted.log.warn(
      { url },
      "random port: PERCH_PUBLIC_URL does not match; use --port for real work",
    );
  }
  const worker = booted.queue.worker({ queues: ["system"], handlers: {} });
  worker.start();
  let stopping: Promise<void> | null = null;
  return {
    url,
    dataDir: layout.dataDir,
    runnerName: runner.info.name,
    stop() {
      stopping ??= (async () => {
        await worker.stop();
        await running.stop();
      })();
      return stopping;
    },
  };
}
