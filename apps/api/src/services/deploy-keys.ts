/**
 * The per-workspace SSH deploy key (spec §5.1, task 1.4): minted on first use, public half shown to
 * members to add to their repositories, private half vault-encrypted and decrypted only to hand a
 * clone on a runner its key file. Rotation replaces both halves; the old key stops working at once.
 */

import type { Bus } from "@perch/bus";
import type { Db, DeployKey } from "@perch/db";
import type { Vault } from "@perch/vault";
import type { ActorContext } from "../auth/authorize.ts";
import { findDeployKey, upsertDeployKey } from "../repos/deploy-keys.ts";
import { generateDeployKey } from "./ssh-keys.ts";

export type DeployKeyDeps = { db: Db; vault: Vault; bus: Bus };

export type DeployKeyView = {
  publicKey: string;
  fingerprint: string;
  createdAt: Date;
  updatedAt: Date;
};

function aad(workspaceId: string): string {
  return `deploy-key:${workspaceId}`;
}

function view(row: DeployKey): DeployKeyView {
  return {
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function mint(deps: DeployKeyDeps, workspaceId: string): Promise<DeployKey> {
  const pair = generateDeployKey(`perch-${workspaceId}`);
  return upsertDeployKey(deps.db, {
    workspaceId,
    publicKey: pair.publicKey,
    fingerprint: pair.fingerprint,
    privateKeyCiphertext: await deps.vault.encrypt(pair.privateKey, aad(workspaceId)),
  });
}

export async function getOrCreateDeployKey(
  deps: DeployKeyDeps,
  workspaceId: string,
): Promise<DeployKeyView> {
  const existing = await findDeployKey(deps.db, workspaceId);
  return view(existing ?? (await mint(deps, workspaceId)));
}

export async function rotateDeployKey(
  deps: DeployKeyDeps,
  workspaceId: string,
  by: ActorContext,
): Promise<DeployKeyView> {
  const row = await mint(deps, workspaceId);
  await deps.bus.publish("workspace.updated", { workspaceId, changes: ["deploy_key"] }, by);
  return view(row);
}

/** The private key for a clone; null when the workspace has none yet. Never logged, never returned to a client. */
export async function decryptDeployKey(
  deps: Pick<DeployKeyDeps, "db" | "vault">,
  workspaceId: string,
): Promise<string | null> {
  const row = await findDeployKey(deps.db, workspaceId);
  if (!row) return null;
  return deps.vault.decryptString(row.privateKeyCiphertext, aad(workspaceId));
}
