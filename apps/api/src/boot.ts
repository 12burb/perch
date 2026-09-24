/**
 * Wires the process: env → database (migrations on boot) → bus, vault, queue → app. Shared by the api
 * entrypoint, the worker entrypoint, tests, and the perch binary (laptop mode).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBotEvents } from "@perch/bots";
import { type Bus, createBus } from "@perch/bus";
import { createDb, type Db, type PgliteRuntime } from "@perch/db";
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
import { interruptHops, interruptRuns } from "./repos/bots.ts";
import { appendEvent, interruptSessions } from "./repos/sessions.ts";
import {
  createRunnerChannel,
  type RunnerChannel,
  type RunnerChannelOptions,
} from "./runners/channel.ts";
import { RunnerRegistry } from "./runners/registry.ts";
import type { RunningServer } from "./server.ts";
import { AgentBotsService } from "./services/agent-bots.ts";
import { AgentsService } from "./services/agents.ts";
import { AuditService } from "./services/audit.ts";
import { BackgroundService } from "./services/background.ts";
import { BackupsService } from "./services/backups.ts";
import { BotApiService } from "./services/bot-api.ts";
import { BotsService } from "./services/bots.ts";
import { BrainsService } from "./services/brains.ts";
import { BudgetsService } from "./services/budgets.ts";
import { ConnectionsService } from "./services/connections.ts";
import { DbBrowser } from "./services/db-browser.ts";
import { DeployService } from "./services/deploys.ts";
import { LocalMcpService } from "./services/local-mcp.ts";
import { McpGateway } from "./services/mcp.ts";
import { MergeQueueService } from "./services/merge-queue.ts";
import { ModelGatewayService } from "./services/model-gateway.ts";
import { NestService } from "./services/nest.ts";
import { PerchMcpService } from "./services/perch-mcp.ts";
import { PlanningService } from "./services/planning.ts";
import { PolicyService } from "./services/policy.ts";
import { PreflightService } from "./services/preflight.ts";
import { PreviewService } from "./services/previews.ts";
import { resetInterruptedSetups } from "./services/projects.ts";
import { PullRequestsService } from "./services/pull-requests.ts";
import { RaceService } from "./services/races.ts";
import { RepoIndexService } from "./services/repo-index.ts";
import { SessionService, type SessionServiceOptions } from "./services/sessions.ts";
import { SpecBotsService } from "./services/spec-bots.ts";
import { TestingLoopService } from "./services/testing-loop.ts";
import { VirtualKeysService } from "./services/virtual-keys.ts";
import { WebhooksService } from "./services/webhooks.ts";
import { WorkService } from "./services/work.ts";
import { requestVolumeBackup } from "./supervisor/queue.ts";
import { startTracing } from "./telemetry/tracing.ts";
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
  /**
   * Whether this process owns the work a restart interrupts — project setups, coding sessions, bot
   * runs, the merge queue — and so settles it at boot and keeps the queue moving (ADR-0165,
   * ADR-0177). On by default: the api entrypoint, laptop mode and the tests. The supervisor, the
   * jobs worker, `backup` and `restore` turn it off, because they boot beside an api that is still
   * doing that work, and settling it from there would fail it under the api's feet.
   */
  recover?: boolean;
  /** How often the merge queue looks for work nothing is moving (tests shorten it). */
  mergeQueueResumeMs?: number;
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
  // Traces, when there is somewhere to send them (spec §8; task 3.22). Off is the default.
  const tracing = await startTracing(env, log);
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
  // The ACP adapter lives on the project's runner (task 1.9): one bridge per runner link. So do
  // OpenCode (1.10), the cli-harness lane (1.11), and Hermes (3.8) — the runner decides which of
  // them it can actually host, and says so when it cannot.
  for (const id of ["acp", "opencode", "cli-harness", "hermes"] as const) {
    engines.register(id, ({ link }) => {
      if (!link)
        throw new EngineError(`the ${id} engine runs on a project's runner`, "unavailable");
      return runnerEngine({ id, link });
    });
  }
  for (const engine of options.engines ?? []) engines.register(engine.id, engine);
  const flags = createFlags({ db: db.db, env });
  const recover = options.recover !== false;
  // What a restart interrupted is settled before anything can ask for it (ADR-0165) — by the
  // process that owns it, and no other (ADR-0177).
  if (recover) await resetInterruptedSetups(db.db);
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
    // Connectors this instance was given rather than built with (spec §5.5; task 3.11).
    connectorsDir: env.connectorsDir,
  });
  const mcp = new McpGateway({
    db: db.db,
    bus,
    log,
    connections,
    secret: env.sessionSecret,
    publicUrl: env.publicUrl,
  });
  // The MCP servers a runner hosts itself (task 3.24): no credential, so no vault and no grant —
  // the project's runner spawns the command and the api speaks MCP down the stream.
  const localMcp = new LocalMcpService({ db: db.db, bus, log, registry: runners });
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
  const sessions = new SessionService(
    {
      db: db.db,
      bus,
      registry: runners,
      engines,
      flags,
      brains,
      mcp,
      vault,
      log,
      // Eyes on a preview, when there is one to look at and a command to look with (task 3.21).
      previews,
      playwrightMcp: env.playwrightMcp,
    },
    options.sessions ?? {},
  );
  // A mention that opens a coding session (spec §5.3 "Agent bots"; task 3.7). It is its own
  // service because it belongs to neither side: the bots service asks it for a session, the
  // session's own events come back on the bus, and the thread hears about both.
  const agentBots = new AgentBotsService({
    db: db.db,
    bus,
    botEvents,
    sessions,
    connections,
    policy,
    log,
    runners: { db: db.db, registry: runners },
  });
  // The gateway at /v1, and the keys it is reached with (task 4.1).
  const modelGateway = new ModelGatewayService({ db, bus, log, brains });
  const virtualKeys = new VirtualKeysService({ db, bus, log });
  // What may be spent, counted from the same ledger the gateway writes (task 4.2).
  const budgets = new BudgetsService({ db, bus, log });
  // The instance's own backups (task 4.4): the database, the files beside it, and the vault key's
  // fingerprint, in a directory that can be carried somewhere else.
  // Who did what and when, and for how long it is remembered (task 4.5).
  const audit = new AuditService({ db, log });
  const backups = new BackupsService({
    env,
    db,
    log,
    version: { version: versionInfo(env).version },
    // Only a docker-mode instance has a supervisor to ask for the project volumes; in laptop mode
    // the projects live beside the data directory and are the person's own files.
    ...(env.runner.mode === "inprocess"
      ? {}
      : { requestVolumes: (dir: string) => requestVolumeBackup(queue, dir) }),
  });
  const bots = new BotsService({
    db: db.db,
    bus,
    botEvents,
    brains,
    policy,
    queue,
    log,
    // MCP attach (spec §5.3; task 3.6): the grant decides what a bot may reach, the gateway
    // carries the connection's own token, and the bot's context never sees either.
    connections,
    mcp,
    localMcp,
    // A mention that opens a coding session (spec §5.3 "Agent bots"; task 3.7).
    agents: agentBots,
    // The workspace's ceilings and the ledger under them (task 4.2).
    budgets,
    usage: modelGateway,
    ...(env.search ? { search: env.search } : {}),
  });
  // The Nest as members (spec §5.3; task 3.9): a roster an admin installs, each entry becoming an
  // ordinary bot — external with its own token, or an agent bot on the hermes engine.
  const nest = new NestService({ db: db.db, bots });
  // Bots that live in a project's repository (spec §5.3; task 3.1): the sync needs the bot service
  // for the cron triggers a synced bot brings with it.
  const specBots = new SpecBotsService({ db: db.db, bots, log });
  // What a provider posts when something happens (spec §3.5; task 3.4): checked against the
  // manifest's own scheme, refused if it is a replay, and posted as a card.
  const webhooks = new WebhooksService({ db: db.db, bus, vault, connections, bots, log });
  // The Bot API seam (spec §7.3; task 2.19): what an external bot may do, and what it is told.
  const botApi = new BotApiService({
    db: db.db,
    bus,
    botEvents,
    mcp,
    connections,
    sessions,
    log,
  });
  // Work items, and the board that follows the sessions doing them (task 3.13).
  const work = new WorkService({ db, bus, log, sessions });
  // What the work is planned into: cycles, modules, saved views, relations (task 3.26).
  const planning = new PlanningService({ db, bus, log });
  // And the queue those branches land through, one at a time (task 3.15).
  const mergeQueue = new MergeQueueService({
    db,
    bus,
    log,
    sessions,
    registry: runners,
    ...(options.mergeQueueResumeMs ? { resumeEveryMs: options.mergeQueueResumeMs } : {}),
  });
  // The same task on several engines at once, compared and decided (task 3.16).
  const races = new RaceService({ db, bus, log, sessions, mergeQueue, registry: runners });
  // A run nobody is watching, reporting as one card and waking a phone only when it has to
  // (spec §5.7; task 3.17).
  const background = new BackgroundService({
    db,
    bus,
    log,
    vault,
    env: { publicUrl: env.publicUrl },
    sessions,
  });
  // The project's own tests after a round that wrote something, with a failure fed back as the
  // next turn and a bound on how many of those there are (task 3.18).
  const testingLoop = new TestingLoopService({ db, log, sessions, registry: runners });
  sessions.onRoundEnd((session) => testingLoop.afterRound(session));
  // What is working right now, across sessions and bots, and one way to stop any of it (task 3.19).
  const agents = new AgentsService({ db, bus, log, sessions, bots });
  // The connection's pull requests, and the session that answers a review (task 3.20).
  const pullRequests = new PullRequestsService({ connections, log, sessions });
  // The project's own lint, test and build, and a look at each of its routes (task 3.21).
  const preflight = new PreflightService({ log });
  // Perch's own MCP server (task 3.12): the same services the REST handlers use, behind an api
  // token's scopes.
  const perchMcp = new PerchMcpService({
    db,
    log,
    sessions,
    connections,
    mcp,
    work,
    bus,
    env: { publicUrl: env.publicUrl },
  });
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
    nest,
    policy,
    connections,
    mcp,
    localMcp,
    perchMcp,
    work,
    planning,
    modelGateway,
    virtualKeys,
    budgets,
    backups,
    audit,
    mergeQueue,
    races,
    background,
    testingLoop,
    agents,
    pullRequests,
    preflight,
    previews,
    deploys,
    dbBrowser,
    repoIndex,
    specBots,
    webhooks,
    botApi,
    flags,
    log,
    version: versionInfo(env),
  };
  const stopAudit = startAuditSubscriber({ bus, db, log });
  // A bot hears what is said through the bus like everything else (task 2.6). Shutting down
  // unsubscribes so no new run starts; a run already in flight is abandoned rather than waited for,
  // because one extra tick inside `close` wakes a spin in the teardown that predates bots (ADR-0096).
  const stopBots = bots.start();
  // The same bus, translated into the outward-facing shape a bot is handed (spec §7.3).
  const stopBotApi = botApi.start();
  // A mention reaches a phone through the same bus everything else travels on (task 2.3).
  const stopPush = startPushSubscriber({ bus, db, vault, env, log });
  // And what needs a person lands in their inbox off the same bus (task 2.10).
  const stopInbox = startInboxSubscriber({ bus, db, log });
  // A session an agent bot opened reports back into the thread it came from (task 3.7).
  const stopAgentBots = agentBots.start();
  // And the board follows the sessions doing its items, so nobody drags a card (task 3.13).
  const stopWork = work.start();
  // A race hears its entrants finish the same way the board hears its sessions (task 3.16).
  const stopRaces = races.watch();
  // And a background session's card is rewritten by the same seam (task 3.17).
  const stopBackground = background.watch();
  // Now that everything that follows a session is listening: what the last process left running is
  // ended and said so on the bus, so the board, races and cards move on (ADR-0177). Then the merge
  // queue picks up what was waiting, and keeps an eye on it.
  let stopMergeQueue = () => {};
  if (recover) {
    await settleInterrupted({ db: db.db, bus, log });
    stopMergeQueue = mergeQueue.start();
  }
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
      stopMergeQueue();
      stopBots();
      stopBotApi();
      stopAudit();
      stopPush();
      stopInbox();
      stopAgentBots();
      stopWork();
      stopRaces();
      stopBackground();
      testingLoop.close();
      sessions.close();
      await runnerChannel.close();
      await runners.closeAll();
      // What a bot was in the middle of saying finishes, so its `bot_runs` row is not left
      // `running` for ever (task 2.6's note in ADR-0096, possible again since ADR-0109).
      await bots.settled();
      await db.close();
      // Last: a span written while the exporter was shutting down is a span nobody gets.
      await tracing?.shutdown().catch(() => undefined);
    },
  };
}

/** What a session or a bot run left running by a restart is marked with (ADR-0177). */
export const INTERRUPTED = "interrupted by a restart";

const SYSTEM = { actor: { type: "system" as const }, meta: {} };

/**
 * The rest of ADR-0165's boot settlement (ADR-0177). A coding session's round, its pending
 * permission and its engine handle live in the process that ran it, and so does a bot's run: after a
 * restart nothing will ever finish them, and whatever waits on them — a race waiting for its entrants,
 * a board item in `running`, agent presence, an inbox permission — waits for ever. So each is ended
 * as an error with the reason, and said so on the bus exactly as if its round had failed: the
 * transcript gets the error, `session.status` moves the board, the race and the card, and
 * `bot.run_failed` tells the bot's owner.
 */
export async function settleInterrupted(deps: {
  db: Db;
  bus: Bus;
  log: Logger;
}): Promise<{ sessions: number; runs: number; hops: number }> {
  const sessions = await interruptSessions(deps.db, INTERRUPTED);
  for (const session of sessions) {
    // The same audience the session's own events have (an inline lane stays off the workspace).
    const topics =
      session.kind === "inline"
        ? [`session:${session.id}`]
        : [`session:${session.id}`, `ws:${session.workspaceId}`];
    try {
      const { seq } = await appendEvent(deps.db, session.id, {
        type: "error",
        message: INTERRUPTED,
      });
      const base = { workspaceId: session.workspaceId, sessionId: session.id };
      await deps.bus.publish(
        "session.error",
        { ...base, seq, message: INTERRUPTED },
        {
          ...SYSTEM,
          topics,
        },
      );
      await deps.bus.publish("session.status", { ...base, status: "error" }, { ...SYSTEM, topics });
    } catch (error) {
      deps.log.error({ err: error, sessionId: session.id }, "an interrupted session was not told");
    }
  }
  const runs = await interruptRuns(deps.db, INTERRUPTED);
  for (const run of runs) {
    await deps.bus.publish(
      "bot.run_failed",
      { workspaceId: run.workspaceId, botId: run.botId, runId: run.id, error: INTERRUPTED },
      SYSTEM,
    );
  }
  const hops = await interruptHops(deps.db);
  if (sessions.length + runs.length + hops.length > 0) {
    deps.log.warn(
      { sessions: sessions.length, runs: runs.length, hops: hops.length },
      "work a restart interrupted was ended",
    );
  }
  return { sessions: sessions.length, runs: runs.length, hops: hops.length };
}

/** How long a stopping api waits for the requests already in flight before it closes anyway. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * How an entrypoint stops (A-co-17): the server first, so no request is served once the bus
 * subscribers that record it (audit, inbox, push, bots) are gone — those already in flight run to
 * their end, for as long as the grace allows. Then whatever else takes work (the jobs worker, the
 * supervisor), and last the teardown `close()` does in its own order.
 */
export async function shutdown(
  booted: Pick<Booted, "close">,
  parts: { server?: RunningServer | null; stops?: Array<() => Promise<void>> } = {},
  graceMs = SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (parts.server) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      parts.server.server.stop(true),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
  }
  for (const stop of parts.stops ?? []) await stop();
  await booted.close();
}
