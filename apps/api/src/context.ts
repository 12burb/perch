import type { BotEvents } from "@perch/bots";
import type { Bus } from "@perch/bus";
import type { ApiTokenScopes, DbHandle, Runner, User } from "@perch/db";
import type { EngineRegistry } from "@perch/engines";
import type { Queue } from "@perch/jobs";
import type { Vault } from "@perch/vault";
import type { Logger } from "pino";
import type { Auth } from "./auth/auth.ts";
import type { Env } from "./env.ts";
import type { Flags } from "./flags.ts";
import type { RunnerRegistry } from "./runners/registry.ts";
import type { AgentsService } from "./services/agents.ts";
import type { BackgroundService } from "./services/background.ts";
import type { BotApiService } from "./services/bot-api.ts";
import type { BotsService } from "./services/bots.ts";
import type { BrainsService } from "./services/brains.ts";
import type { ConnectionsService } from "./services/connections.ts";
import type { DbBrowser } from "./services/db-browser.ts";
import type { DeployService } from "./services/deploys.ts";
import type { LocalMcpService } from "./services/local-mcp.ts";
import type { McpGateway } from "./services/mcp.ts";
import type { MergeQueueService } from "./services/merge-queue.ts";
import type { NestService } from "./services/nest.ts";
import type { PerchMcpService } from "./services/perch-mcp.ts";
import type { PlanningService } from "./services/planning.ts";
import type { PolicyService } from "./services/policy.ts";
import type { PreflightService } from "./services/preflight.ts";
import type { PreviewService } from "./services/previews.ts";
import type { PullRequestsService } from "./services/pull-requests.ts";
import type { RaceService } from "./services/races.ts";
import type { RepoIndexService } from "./services/repo-index.ts";
import type { SessionService } from "./services/sessions.ts";
import type { SpecBotsService } from "./services/spec-bots.ts";
import type { TestingLoopService } from "./services/testing-loop.ts";
import type { WebhooksService } from "./services/webhooks.ts";
import type { WorkService } from "./services/work.ts";

/** What every handler can reach through the Hono context. */
export type AppVariables = {
  requestId: string;
  log: Logger;
  workspaceId?: string;
  userId?: string;
  user?: User;
  authKind?: "session" | "token";
  tokenScopes?: ApiTokenScopes;
  /** The runner a connect token resolved to (the /api/runner upgrade only). */
  runner?: Runner;
};

export type AppEnv = { Variables: AppVariables };

/** The wiring the app is built with (spec §9.1: services are pure functions over Db and Bus). */
export type Deps = {
  env: Env;
  db: DbHandle;
  bus: Bus;
  /** Where Bot API events are handed over (spec §7.3; task 2.5): not the bus, which is §7.7's own catalog. */
  botEvents: BotEvents;
  vault: Vault;
  queue: Queue;
  auth: Auth;
  runners: RunnerRegistry;
  /** The engines sessions can open on (task 1.8). */
  engines: EngineRegistry;
  sessions: SessionService;
  /** Credentials, model profiles, and the catalog behind them (task 1.15). */
  brains: BrainsService;
  /** The native bot runtime: triggers, tools, runs and their ledger (task 2.6). */
  bots: BotsService;
  /** Perch's own MCP server: the chat, search, sessions and connections as tools (task 3.12). */
  perchMcp: PerchMcpService;
  /** Work items and the board, moved by the sessions doing them (task 3.13). */
  work: WorkService;
  /** Cycles, modules, saved views and relations (task 3.26). */
  planning: PlanningService;
  /** Branches landing one at a time, behind the project's own checks (task 3.15). */
  mergeQueue: MergeQueueService;
  /** The same task on several engines at once, and the choice between them (task 3.16). */
  races: RaceService;
  /** Sessions that run to a finish line and report as one card (task 3.17). */
  background: BackgroundService;
  /** The project's tests after a round, and a failure fed back as a turn (task 3.18). */
  testingLoop: TestingLoopService;
  /** What every session and bot is doing right now, and the Stop beside it (task 3.19). */
  agents: AgentsService;
  /** The connection's pull requests, their reviews, and the agent that answers one (task 3.20). */
  pullRequests: PullRequestsService;
  /** The project's own checks and a look at each route, before a push (task 3.21). */
  preflight: PreflightService;
  /** The Nest roster, installed into a workspace (spec §5.3; task 3.9). */
  nest: NestService;
  /** What may happen here: `.perch/policy.yaml`, merged and enforced (task 2.11). */
  policy: PolicyService;
  connections: ConnectionsService;
  mcp: McpGateway;
  /** The MCP servers a runner hosts itself (task 3.24). */
  localMcp: LocalMcpService;
  previews: PreviewService;
  /** The Deploy button: a provider builds the project, and the card in a thread says so (2.15). */
  deploys: DeployService;
  /** The database panel, read-only by default (task 2.15). */
  dbBrowser: DbBrowser;
  /** What Perch knows about a repository: the index behind @codebase (task 2.17). */
  repoIndex: RepoIndexService;
  /** Bots that live in a project's repository (spec §5.3; task 3.1). */
  specBots: SpecBotsService;
  /** What a provider posts when something happens (spec §3.5; task 3.4). */
  webhooks: WebhooksService;
  /** The Bot API seam (spec §7.3; task 2.19): what an external bot may do, and what it is told. */
  botApi: BotApiService;
  /** Feature flags (spec §9.1), default off. */
  flags: Flags;
  log: Logger;
  version: VersionInfo;
};

export type VersionInfo = {
  version: string;
  commit: string | undefined;
  apiVersion: string;
  runtime: string;
  mode: "laptop" | "team";
};

/** The current REST contract version, sent and accepted in the Perch-Version header (spec §7.1). */
export const API_VERSION = "2026-09-01";
export const SUPPORTED_API_VERSIONS: readonly string[] = [API_VERSION];
