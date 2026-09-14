/**
 * Runners and their connect tokens (spec §3.2, §7.6, ADR-0066). A connect token (`prt_…`) is minted
 * for one runner row, shown once, stored as a sha256 hash, and presented as a bearer on the
 * /api/runner upgrade; the supervisor mints them for hosted runners (task 1.2) and
 * `perch runner connect` for local ones (task 1.3).
 */
import type { Db, Runner, RunnerCapabilities, RunnerToken } from "@perch/db";
import {
  deleteRunner,
  findRunnerById,
  findRunnerTokenByHash,
  insertRunner,
  insertRunnerToken,
  listRunnersVisibleTo,
  revokeRunnerToken as revokeRow,
} from "../repos/runners.ts";
import type { RunnerRegistry } from "../runners/registry.ts";
import { hashToken } from "./tokens.ts";

export const RUNNER_TOKEN_PREFIX = "prt_";
/** Connect tokens last a month unless a shorter life is asked for. */
export const RUNNER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createRunner(
  db: Db,
  input: {
    workspaceId: string | null;
    kind: Runner["kind"];
    name: string;
    ownerUserId?: string | null;
    capabilities?: RunnerCapabilities;
  },
): Promise<Runner> {
  return insertRunner(db, input);
}

export function getRunner(db: Db, id: string): Promise<Runner | null> {
  return findRunnerById(db, id);
}

export type MintedRunnerToken = { token: string; row: RunnerToken };

/** Mints a connect token for a runner; the plaintext is returned exactly once. */
export async function mintRunnerToken(
  db: Db,
  runnerId: string,
  options: { ttlMs?: number } = {},
): Promise<MintedRunnerToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `${RUNNER_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
  const row = await insertRunnerToken(db, {
    runnerId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + (options.ttlMs ?? RUNNER_TOKEN_TTL_MS)),
  });
  return { token, row };
}

export function revokeRunnerToken(db: Db, runnerId: string, id: string): Promise<boolean> {
  return revokeRow(db, runnerId, id);
}

/** The runner a connect token belongs to; null for an unknown, revoked, or expired token. */
export async function authenticateRunnerToken(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<Runner | null> {
  if (!token.startsWith(RUNNER_TOKEN_PREFIX)) return null;
  const found = await findRunnerTokenByHash(db, hashToken(token));
  if (!found) return null;
  if (found.token.revokedAt) return null;
  if (found.token.expiresAt.getTime() <= now.getTime()) return null;
  return found.runner;
}

export { requestRunner } from "../supervisor/queue.ts";

/** A runner as the Environments page sees it: the row plus what the registry knows right now. */
export type RunnerView = {
  id: string;
  workspaceId: string | null;
  kind: Runner["kind"];
  name: string;
  status: string;
  ownerUserId: string | null;
  capabilities: RunnerCapabilities;
  lastSeenAt: Date | null;
  createdAt: Date;
  connected: boolean;
  load: { cpu?: number; memoryMb?: number };
  sessions: number;
};

export async function listRunnersForWorkspace(
  db: Db,
  registry: RunnerRegistry,
  workspaceId: string,
): Promise<RunnerView[]> {
  const rows = await listRunnersVisibleTo(db, workspaceId);
  return rows.map((row) => {
    const live = registry.get(row.id);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      name: row.name,
      status: live ? "online" : row.status === "online" ? "offline" : row.status,
      ownerUserId: row.ownerUserId,
      capabilities: row.capabilities,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
      connected: live !== undefined,
      load: live?.load ?? {},
      sessions: live?.sessions.length ?? 0,
    };
  });
}

/** A member's own machine: a local (or remote) runner row and its connect token, shown once. */
export async function connectOwnRunner(
  db: Db,
  input: { workspaceId: string; ownerUserId: string; name: string; kind?: "local" | "remote" },
): Promise<{ runner: Runner; token: string }> {
  const runner = await insertRunner(db, {
    workspaceId: input.workspaceId,
    kind: input.kind ?? "local",
    name: input.name,
    ownerUserId: input.ownerUserId,
  });
  const { token } = await mintRunnerToken(db, runner.id);
  return { runner, token };
}

/** The command a person runs on their machine (docs/runners.md). */
export function connectCommand(publicUrl: string, token: string, name: string): string {
  return `perch runner connect ${publicUrl} --token ${token} --name ${JSON.stringify(name)}`;
}

/** Removes a runner: its tokens go with it (cascade) and a connected one is disconnected. */
export async function removeRunner(
  db: Db,
  registry: RunnerRegistry,
  runnerId: string,
): Promise<boolean> {
  await registry.detach(runnerId);
  return deleteRunner(db, runnerId);
}
