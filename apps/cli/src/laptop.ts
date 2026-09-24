/**
 * Laptop mode as a function (spec §2): api + web + the in-process runner on PGlite under a data
 * directory. `perch dev` calls it and waits for a signal; the desktop app (apps/desktop, ADR-0063)
 * calls it and keeps the process for its window. It holds the data directory's lock from before
 * PGlite opens until `stop()` has closed everything (ADR-0175): a second Perch on the same files
 * is refused rather than left to overwrite this one's committed work.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Booted, boot } from "@perch/api/boot";
import { loadEnv } from "@perch/api/env";
import { repoIndexJobHandlers } from "@perch/api/jobs";
import { serve } from "@perch/api/server";
import { REPO_INDEX_QUEUE } from "@perch/api/services/repo-index";
import { createInProcessRunner } from "@perch/runner";
import { lockDataDir } from "./data-lock.ts";
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
  /** The booted instance, for a command that does more than serve it (`perch demo`, task 4.8). */
  booted: Booted;
  /**
   * Stops the jobs worker and the server, which closes the instance (sessions, runners, bots, the
   * database; ADR-0109), and lets go of the data directory; idempotent.
   */
  stop(): Promise<void>;
};

/** A port from a flag or the environment; null when it is not a port. */
export function laptopPort(value: string | number | undefined): number | null {
  const port = Number(value ?? process.env.PORT ?? 3000);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

export async function startLaptop(options: LaptopOptions = {}): Promise<Laptop> {
  const layout = laptopLayout(dataDirFrom(options.dataDir));
  const requestedPort = laptopPort(options.port);
  if (requestedPort === null) throw new Error(`bad port: ${options.port}`);
  const lock = lockDataDir(layout.dataDir, "perch dev");
  try {
    return await bootLaptop(layout, requestedPort, options, lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function bootLaptop(
  layout: ReturnType<typeof laptopLayout>,
  requestedPort: number,
  options: LaptopOptions,
  lock: ReturnType<typeof lockDataDir>,
): Promise<Laptop> {
  mkdirSync(layout.files, { recursive: true });
  const host = options.host ?? "127.0.0.1";
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
  let running: ReturnType<typeof serve>;
  try {
    booted.runners.attach(runner);
    runner.heartbeat();
    running = serve(booted, { port: requestedPort, hostname: host });
  } catch (error) {
    // The port was taken, say: the database is open and has to be closed before the lock goes.
    await booted.close();
    throw error;
  }
  const url = requestedPort === 0 ? running.url : publicUrl;
  lock.describe({ url });
  if (requestedPort === 0) {
    // The public URL must carry the real port for passkeys and links: rebind is not possible after
    // boot, so a random port is for smoke tests only.
    booted.log.warn(
      { url },
      "random port: PERCH_PUBLIC_URL does not match; use --port for real work",
    );
  }
  const worker = booted.queue.worker({
    queues: ["system", "bots", REPO_INDEX_QUEUE],
    handlers: { ...booted.bots.jobHandlers(), ...repoIndexJobHandlers(booted) },
  });
  worker.start();
  let stopping: Promise<void> | null = null;
  return {
    url,
    dataDir: layout.dataDir,
    runnerName: runner.info.name,
    booted,
    stop() {
      stopping ??= (async () => {
        try {
          await worker.stop();
          // The server's stop closes the instance (Booted.close, ADR-0109): sessions, runners and
          // their ptys, previews and agents, a bot's run settled, then the database — and only
          // then may another Perch open the directory.
          await running.stop();
        } finally {
          lock.release();
        }
      })();
      return stopping;
    },
  };
}
