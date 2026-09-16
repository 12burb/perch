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
import type { BotApiService } from "./services/bot-api.ts";
import type { BotsService } from "./services/bots.ts";
import type { BrainsService } from "./services/brains.ts";
import type { ConnectionsService } from "./services/connections.ts";
import type { DbBrowser } from "./services/db-browser.ts";
import type { DeployService } from "./services/deploys.ts";
import type { McpGateway } from "./services/mcp.ts";
import type { PolicyService } from "./services/policy.ts";
import type { PreviewService } from "./services/previews.ts";
import type { RepoIndexService } from "./services/repo-index.ts";
import type { SessionService } from "./services/sessions.ts";
import type { SpecBotsService } from "./services/spec-bots.ts";

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
  /** What may happen here: `.perch/policy.yaml`, merged and enforced (task 2.11). */
  policy: PolicyService;
  connections: ConnectionsService;
  mcp: McpGateway;
  previews: PreviewService;
  /** The Deploy button: a provider builds the project, and the card in a thread says so (2.15). */
  deploys: DeployService;
  /** The database panel, read-only by default (task 2.15). */
  dbBrowser: DbBrowser;
  /** What Perch knows about a repository: the index behind @codebase (task 2.17). */
  repoIndex: RepoIndexService;
  /** Bots that live in a project's repository (spec §5.3; task 3.1). */
  specBots: SpecBotsService;
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
