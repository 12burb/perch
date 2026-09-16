/**
 * Minting, listing and revoking the keys `/v1` is reached with (spec §3.4, §7.1; task 4.1).
 *
 * A key is a secret that spends money, so it follows the same rules an api token does: generated
 * here, hashed before it is stored, shown exactly once, and revocable without deleting what it
 * spent. The calling half — resolving a key and paying for a call — is `ModelGatewayService`.
 */
import type { Bus } from "@perch/bus";
import type { Db, DbHandle, KeyBudget, KeySubject, VirtualKey } from "@perch/db";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  getVirtualKey,
  insertVirtualKey,
  listVirtualKeys,
  revokeVirtualKey,
} from "../repos/virtual-keys.ts";
import { hashKey, mintKey } from "./model-gateway.ts";

export type VirtualKeysDeps = { db: DbHandle; bus: Bus; log: Logger };

export type MintedKey = { key: string; row: VirtualKey };

export class VirtualKeysService {
  constructor(private readonly deps: VirtualKeysDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  list(workspaceId: string): Promise<VirtualKey[]> {
    return listVirtualKeys(this.db, workspaceId);
  }

  /** A new `pk_…`. The plaintext is in the answer and nowhere else, ever again. */
  async mint(input: {
    workspaceId: string;
    name: string;
    subjectType: KeySubject;
    subjectId?: string;
    budget: KeyBudget;
    models: string[];
    expiresAt?: Date;
    createdBy: string;
    by: ActorContext;
  }): Promise<MintedKey> {
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw PerchError.validation("a key cannot expire in the past");
    }
    const { key, prefix } = mintKey();
    const row = await insertVirtualKey(this.db, {
      workspaceId: input.workspaceId,
      subjectType: input.subjectType,
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      name: input.name,
      keyHash: hashKey(key),
      prefix,
      budget: input.budget,
      models: input.models,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdBy: input.createdBy,
    });
    this.deps.log.info(
      { workspaceId: input.workspaceId, virtualKeyId: row.id, subject: input.subjectType },
      "a virtual key was minted",
    );
    return { key, row };
  }

  /** Revoking is a one-way door, and the ledger keeps what the key spent. */
  async revoke(workspaceId: string, id: string, _by: ActorContext): Promise<VirtualKey> {
    const row = await getVirtualKey(this.db, id);
    if (!row || row.workspaceId !== workspaceId) throw PerchError.notFound("virtual key");
    const revoked = await revokeVirtualKey(this.db, id, new Date());
    // Already revoked is not an error: the caller wanted it gone and it is gone.
    return revoked ?? row;
  }
}
