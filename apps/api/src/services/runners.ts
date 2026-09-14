/**
 * Runners and their connect tokens (spec §3.2, §7.6, ADR-0066). A connect token (`prt_…`) is minted
 * for one runner row, shown once, stored as a sha256 hash, and presented as a bearer on the
 * /api/runner upgrade; the supervisor mints them for hosted runners (task 1.2) and
 * `perch runner connect` for local ones (task 1.3).
 */
import type { Db, Runner, RunnerCapabilities, RunnerToken } from "@perch/db";
import {
  findRunnerById,
  findRunnerTokenByHash,
  insertRunner,
  insertRunnerToken,
  revokeRunnerToken as revokeRow,
} from "../repos/runners.ts";
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
