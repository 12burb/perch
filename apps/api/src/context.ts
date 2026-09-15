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
import type { BrainsService } from "./services/brains.ts";
import type { ConnectionsService } from "./services/connections.ts";
import type { McpGateway } from "./services/mcp.ts";
import type { PreviewService } from "./services/previews.ts";
import type { SessionService } from "./services/sessions.ts";

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
  connections: ConnectionsService;
  mcp: McpGateway;
  previews: PreviewService;
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
