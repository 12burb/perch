/**
 * Wires the process: env → database (migrations on boot) → bus, vault, queue → app. Shared by the api
 * entrypoint, the worker entrypoint, tests, and the perch binary (laptop mode).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBotEvents } from "@perch/bots";
import { createBus } from "@perch/bus";
import { createDb, type PgliteRuntime } from "@perch/db";
import { type Engine, EngineError, EngineRegistry, runnerEngine } from "@perch/engines";
import { createQueue } from "@perch/jobs";
import { createVault } from "@perch/vault";
import { type AppOptions, createApp } from "./app.ts";
import { startAuditSubscriber } from "./audit/subscriber.ts";
import { createAuth } from "./auth/auth.ts";
import { API_VERSION, type Deps, type VersionInfo } from "./context.ts";
import { type Env, loadEnv } from "./env.ts";
import { createFlags } from "./flags.ts";
import { startInboxSubscriber } from "./inbox/subscriber.ts";
import { createLogger, type Logger } from "./logging.ts";
import { startPushSubscriber } from "./push/subscriber.ts";
import {
  createRunnerChannel,
  type RunnerChannel,
  type RunnerChannelOptions,
} from "./runners/channel.ts";
import { RunnerRegistry } from "./runners/registry.ts";
import { BotsService } from "./services/bots.ts";
import { BrainsService } from "./services/brains.ts";
import { ConnectionsService } from "./services/connections.ts";
import { DbBrowser } from "./services/db-browser.ts";
import { DeployService } from "./services/deploys.ts";
import { McpGateway } from "./services/mcp.ts";
import { PolicyService } from "./services/policy.ts";
import { PreviewService } from "./services/previews.ts";
import { RepoIndexService } from "./services/repo-index.ts";
import { SessionService, type SessionServiceOptions } from "./services/sessions.ts";
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
  /** Engines sessions can open on (task 1.8): tests pass the fake; adapters register with their tasks. */
  engines?: Engine[];
  sessions?: SessionServiceOptions;
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
  // Bot API events travel their own seam (spec §7.3): the socket and the signed webhook subscribe
  // here in tasks 2.6 and 2.7, and a subscriber that throws never fails whoever caused the event.
  const botEvents = createBotEvents({
    onError: (error, event) =>
      log.error({ err: error, type: event.type, botId: event.botId }, "bot event handler failed"),
  });
  const vault = createVault({ masterKey: env.masterKey });
  const queue = createQueue({ db: db.db });
  const auth = createAuth({ env, db, log });
  const runners = new RunnerRegistry(bus);
  const engines = new EngineRegistry();
  // The ACP adapter lives on the project's runner (task 1.9): one bridge per runner link.
  for (const id of ["acp", "opencode", "cli-harness"] as const) {
    engines.register(id, ({ link }) => {
      if (!link)
        throw new EngineError(`the ${id} engine runs on a project's runner`, "unavailable");
      return runnerEngine({ id, link });
    });
  }
  for (const engine of options.engines ?? []) engines.register(engine.id, engine);
  const flags = createFlags({ db: db.db, env });
  const brains = new BrainsService({
    db: db.db,
    bus,
    vault,
    log,
    ...(env.ollamaUrls.length > 0 ? { ollamaUrls: env.ollamaUrls } : {}),
  });
  const connections = new ConnectionsService({
    db: db.db,
    bus,
    vault,
    log,
    publicUrl: env.publicUrl,
  });
  const mcp = new McpGateway({
    db: db.db,
    bus,
    log,
    connections,
    secret: env.sessionSecret,
    publicUrl: env.publicUrl,
  });
  const previews = new PreviewService({
    db: db.db,
    bus,
    registry: runners,
    publicUrl: env.publicUrl,
    previewDomain: env.previewDomain,
    secret: env.sessionSecret,
  });
  const policy = new PolicyService({ db: db.db, bus });
  // The Deploy button and the database panel (task 2.15): both run on a connection's own token —
  // the first against the provider's REST API, the second through the MCP gateway.
  const deploys = new DeployService({ db, bus, connections });
  // What Perch knows about a repository: the index behind @codebase (task 2.17).
  const repoIndex = new RepoIndexService({ db: db.db, bus, brains, log });
  const dbBrowser = new DbBrowser({ connections, gateway: mcp });
  const bots = new BotsService({
    db: db.db,
    bus,
    botEvents,
    brains,
    policy,
    queue,
    log,
    ...(env.search ? { search: env.search } : {}),
  });
  const sessions = new SessionService(
    { db: db.db, bus, registry: runners, engines, flags, brains, mcp, vault, log },
    options.sessions ?? {},
  );
  const deps: Deps = {
    env,
    db,
    bus,
    botEvents,
    vault,
    queue,
    auth,
    runners,
    engines,
    sessions,
    brains,
    bots,
    policy,
    connections,
    mcp,
    previews,
    deploys,
    dbBrowser,
    repoIndex,
    flags,
    log,
    version: versionInfo(env),
  };
  const stopAudit = startAuditSubscriber({ bus, db, log });
  // A bot hears what is said through the bus like everything else (task 2.6). Shutting down
  // unsubscribes so no new run starts; a run already in flight is abandoned rather than waited for,
  // because one extra tick inside `close` wakes a spin in the teardown that predates bots (ADR-0096).
  const stopBots = bots.start();
  // A mention reaches a phone through the same bus everything else travels on (task 2.3).
  const stopPush = startPushSubscriber({ bus, db, vault, env, log });
  // And what needs a person lands in their inbox off the same bus (task 2.10).
  const stopInbox = startInboxSubscriber({ bus, db, log });
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
    /**
     * Teardown, in the one order that makes sense: stop taking new work, let what is running
     * finish, then close what it was running against.
     *
     * Nothing here depends on how many times it yields. That was not true until ADR-0109: one extra
     * `await` anywhere in this function used to leave a runner's "mark offline" write in flight
     * while PGlite closed under it, and PGlite's own close spins forever when that happens.
     */
    close: async () => {
      stopBots();
      stopAudit();
      stopPush();
      stopInbox();
      sessions.close();
      await runnerChannel.close();
      await runners.closeAll();
      // What a bot was in the middle of saying finishes, so its `bot_runs` row is not left
      // `running` for ever (task 2.6's note in ADR-0096, possible again since ADR-0109).
      await bots.settled();
      await db.close();
    },
  };
}
