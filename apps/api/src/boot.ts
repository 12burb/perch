/**
 * Wires the process: env → database (migrations on boot) → bus, vault, queue → app. Shared by the api
 * entrypoint, the worker entrypoint, tests, and the perch binary (laptop mode).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBus } from "@perch/bus";
import { createDb, type PgliteRuntime } from "@perch/db";
import { createQueue } from "@perch/jobs";
import { createVault } from "@perch/vault";
import { type AppOptions, createApp } from "./app.ts";
import { startAuditSubscriber } from "./audit/subscriber.ts";
import { createAuth } from "./auth/auth.ts";
import { API_VERSION, type Deps, type VersionInfo } from "./context.ts";
import { type Env, loadEnv } from "./env.ts";
import { createLogger, type Logger } from "./logging.ts";
import {
  createRunnerChannel,
  type RunnerChannel,
  type RunnerChannelOptions,
} from "./runners/channel.ts";
import { RunnerRegistry } from "./runners/registry.ts";
import { createWsServer, type WsServer } from "./ws/server.ts";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8"),
    ) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function versionInfo(env: Env): VersionInfo {
  return {
    version: process.env.PERCH_VERSION ?? packageVersion(),
    commit: env.commit,
    apiVersion: API_VERSION,
    runtime: `bun ${Bun.version}`,
    mode: env.mode,
  };
}

export type BootOptions = {
  env?: Env;
  log?: Logger;
  /** Skip running migrations (tests that migrate themselves). */
  migrate?: boolean;
  app?: AppOptions;
  /** Embedded PGlite runtime files (the compiled perch binary). */
  pglite?: PgliteRuntime;
  /** Heartbeat and timeout tuning for the runner control channel (tests). */
  runnerChannel?: RunnerChannelOptions;
};

export type Booted = Deps & {
  app: ReturnType<typeof createApp>;
  ws: WsServer;
  runnerChannel: RunnerChannel;
  close: () => Promise<void>;
};

export async function boot(options: BootOptions = {}): Promise<Booted> {
  const env = options.env ?? loadEnv();
  const log = options.log ?? createLogger({ level: env.logLevel, pretty: env.logPretty });
  const db = await createDb({
    url: env.databaseUrl,
    ...(options.pglite ? { pglite: options.pglite } : {}),
  });
  if (options.migrate !== false) {
    const result = await db.migrate();
    log.info({ applied: result.applied, total: result.total, driver: db.driver }, "migrations");
  }
  const bus = createBus({
    onError: (error, event) => log.error({ err: error, type: event.type }, "bus subscriber failed"),
  });
  const vault = createVault({ masterKey: env.masterKey });
  const queue = createQueue({ db: db.db });
  const auth = createAuth({ env, db, log });
  const runners = new RunnerRegistry(bus);
  const deps: Deps = { env, db, bus, vault, queue, auth, runners, log, version: versionInfo(env) };
  const stopAudit = startAuditSubscriber({ bus, db, log });
  const ws = createWsServer({ bus, db: db.db, log });
  const runnerChannel = createRunnerChannel(
    { db: db.db, bus, registry: runners, log },
    ws.upgradeWebSocket,
    options.runnerChannel,
  );
  const app = createApp(deps, { ...options.app, ws, runnerChannel });
  return {
    ...deps,
    app,
    ws,
    runnerChannel,
    close: async () => {
      stopAudit();
      await runnerChannel.close();
      await runners.closeAll();
      await db.close();
    },
  };
}
