import type { Bus } from "@perch/bus";
import type { DbHandle } from "@perch/db";
import type { Queue } from "@perch/jobs";
import type { Vault } from "@perch/vault";
import type { Logger } from "pino";
import type { Env } from "./env.ts";

/** What every handler can reach through the Hono context. */
export type AppVariables = {
  requestId: string;
  log: Logger;
  workspaceId?: string;
  userId?: string;
};

export type AppEnv = { Variables: AppVariables };

/** The wiring the app is built with (spec §9.1: services are pure functions over Db and Bus). */
export type Deps = {
  env: Env;
  db: DbHandle;
  bus: Bus;
  vault: Vault;
  queue: Queue;
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
