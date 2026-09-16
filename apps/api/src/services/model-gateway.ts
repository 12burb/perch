/**
 * The model gateway at `/v1` (spec §3.4, §7.4; task 4.1).
 *
 * Anything that can talk to OpenAI can talk to a Perch: a virtual key in the `Authorization`
 * header, a model profile's name where the model goes, and the workspace's own credential doing
 * the work. The credential never leaves this process — that is the whole point of a gateway — and
 * every call leaves a row in `usage_events` saying what it cost.
 *
 * The fidelity rule of §3.4 still holds: engines get native provider credentials, and this serves
 * chat bots and external consumers. Nothing here is in a session's path.
 */
import type { Bus } from "@perch/bus";
import type {
  Db,
  DbHandle,
  KeySubject,
  ModelProfile,
  UsageActor,
  UsageEvent,
  VirtualKey,
} from "@perch/db";
import { costOf, embed, type LanguageModel, modelFor } from "@perch/gateway";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { listProfiles } from "../repos/brains.ts";
import {
  findVirtualKeyByHash,
  insertUsageEvent,
  spentByKey,
  touchVirtualKey,
} from "../repos/virtual-keys.ts";
import type { BrainsService } from "./brains.ts";

export type ModelGatewayDeps = {
  db: DbHandle;
  bus: Bus;
  log: Logger;
  brains: BrainsService;
};

/** `pk_…`: the prefix §3.4 gives a virtual key. */
export const KEY_PREFIX = "pk_";

export function hashKey(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

export function mintKey(): { key: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = `${KEY_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
  // Enough to tell two keys apart in a list, not enough to be one.
  return { key, prefix: key.slice(0, 11) };
}

/** A key that may make a call right now, with what it is allowed to spend. */
export type ResolvedKey = {
  row: VirtualKey;
  workspaceId: string;
  subjectType: KeySubject;
  subjectId: string | null;
};

/** What one call used, as the ledger and the headers want it. */
export type Spent = {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** What is left of this key's budget, when it has one. */
  remainingUsd: number | null;
};

/** The model to call, and the profile it came from. */
export type Chosen = {
  profile: ModelProfile;
  model: LanguageModel;
  provider: string;
  modelId: string;
};

const DAY_MS = 86_400_000;

function windowStart(period: string | undefined, now: Date): Date | null {
  if (period === "day") return new Date(now.getTime() - DAY_MS);
  if (period === "month") return new Date(now.getTime() - 30 * DAY_MS);
  return null;
}

export class ModelGatewayService {
  constructor(private readonly deps: ModelGatewayDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  /**
   * The key behind a `Bearer pk_…`, or null. Expired, revoked and unknown are one answer on
   * purpose: a caller learns whether their key works, not which of the three it is.
   */
  async resolve(key: string): Promise<ResolvedKey | null> {
    if (!key.startsWith(KEY_PREFIX)) return null;
    const row = await findVirtualKeyByHash(this.db, hashKey(key));
    if (!row) return null;
    const now = new Date();
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
      await touchVirtualKey(this.db, row.id, now);
    }
    return {
      row,
      workspaceId: row.workspaceId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
    };
  }

  /** What is left of a key's budget, or null when it has no ceiling. */
  async remaining(row: VirtualKey, now = new Date()): Promise<number | null> {
    const limit = row.budget.limitUsd;
    if (limit === undefined) return null;
    const spent = await spentByKey(this.db, row.id, windowStart(row.budget.period, now));
    return Math.round((limit - spent) * 1e6) / 1e6;
  }

  /** The profiles this key may name: the workspace's, narrowed by the key's own list. */
  async allowed(key: ResolvedKey): Promise<ModelProfile[]> {
    const all = await listProfiles(this.db, key.workspaceId);
    if (key.row.models.length === 0) return all;
    const wanted = new Set(key.row.models.map((one) => one.toLowerCase()));
    return all.filter((profile) => wanted.has(profile.name.toLowerCase()));
  }

  /**
   * The model a request named (spec §7.4: "model = profile name or provider/model_id on the
   * allow-list"), resolved through this key's allow-list and into something callable.
   */
  async choose(key: ResolvedKey, name: string, userId: string): Promise<Chosen> {
    const profiles = await this.allowed(key);
    const chosen = pick(profiles, name);
    if (!chosen) {
      throw PerchError.notFound("model", {
        detail: `${name} is not a model this key may use`,
      });
    }
    return await this.callable(chosen, userId);
  }

  /** A profile as something to call, with its credential decrypted for this call alone. */
  private async callable(profile: ModelProfile, userId: string): Promise<Chosen> {
    const model = await this.deps.brains.languageModel(profile, userId);
    return { profile, model, provider: profile.provider, modelId: profile.modelId };
  }

  /**
   * The chain to try, in order: the profile itself, then whatever its `fallbacks` name that this
   * key may also use (ADR-0147). A name that is not on the allow-list is skipped rather than
   * refused — a chain is a preference, not a promise about somebody else's key.
   */
  async chain(key: ResolvedKey, first: Chosen, userId: string): Promise<Chosen[]> {
    if (first.profile.fallbacks.length === 0) return [first];
    const profiles = await this.allowed(key);
    const chain: Chosen[] = [first];
    for (const name of first.profile.fallbacks) {
      const next = pick(profiles, name);
      if (!next || next.id === first.profile.id) continue;
      chain.push(await this.callable(next, userId));
    }
    return chain;
  }

  /**
   * Writes what a call cost and says so on the bus. Every caller of a model ends up here — the
   * gateway, and in time the bots and the sessions — so one query answers "what did this cost".
   */
  async record(input: {
    workspaceId: string;
    actorType: UsageActor;
    actorId?: string | null;
    virtualKeyId?: string | null;
    sessionId?: string | null;
    botRunId?: string | null;
    provider: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    costUsd: number;
    by: ActorContext;
  }): Promise<UsageEvent> {
    const row = await insertUsageEvent(this.db, input);
    await this.deps.bus.publish(
      "usage.recorded",
      {
        workspaceId: input.workspaceId,
        usageEventId: row.id,
        // §7.7's actor kinds are the four a person can be in this workspace; a key that is nobody
        // in particular says `system` on the bus and stays `external` in the ledger.
        actorType: input.actorType === "external" ? "system" : input.actorType,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        provider: input.provider,
        modelId: input.modelId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: Number(row.costUsd),
      },
      { ...input.by, topics: [`ws:${input.workspaceId}`] },
    );
    return row;
  }

  /** What a call cost, from its tokens — the same table a bot run is priced with. */
  cost(modelId: string, usage: { input: number; output: number }): number {
    return costOf(modelId, usage);
  }

  /**
   * Embeddings through the gateway (spec §3.4: 1024 dimensions everywhere). The profile says which
   * model; the credential is this process's business and nobody else's.
   */
  async embed(input: {
    key: ResolvedKey;
    name: string;
    texts: string[];
    userId: string;
  }): Promise<{ vectors: number[][]; profile: ModelProfile }> {
    const profiles = await this.allowed(input.key);
    const profile = pick(profiles, input.name);
    if (!profile) {
      throw PerchError.notFound("model", {
        detail: `${input.name} is not a model this key may use`,
      });
    }
    const credential = profile.credentialId
      ? await this.deps.brains.credentialFor(
          input.key.workspaceId,
          input.userId,
          profile.credentialId,
        )
      : null;
    const vectors = await embed({
      provider: profile.provider,
      model: profile.modelId,
      input: input.texts,
      ...(credential ? { apiKey: await this.deps.brains.secretOf(credential) } : {}),
      ...(credential?.baseUrl ? { baseUrl: credential.baseUrl } : {}),
    });
    return { vectors, profile };
  }

  /** The model list `/v1/models` answers with: the profiles this key may name. */
  async models(key: ResolvedKey): Promise<ModelProfile[]> {
    return await this.allowed(key);
  }

  /** A model this call may use, made callable — for a caller that already has the profile. */
  async modelFrom(profile: ModelProfile, userId: string): Promise<Chosen> {
    return await this.callable(profile, userId);
  }
}

/** `chat`, `openai/gpt-4o` or a profile's own name — all three name one profile. */
function pick(profiles: readonly ModelProfile[], name: string): ModelProfile | null {
  const wanted = name.trim().toLowerCase();
  const byName = profiles.find((one) => one.name.toLowerCase() === wanted);
  if (byName) return byName;
  const byQualified = profiles.find(
    (one) => `${one.provider}/${one.modelId}`.toLowerCase() === wanted,
  );
  if (byQualified) return byQualified;
  // Bare model ids are how most clients are configured; the first profile serving it wins.
  return profiles.find((one) => one.modelId.toLowerCase() === wanted) ?? null;
}

/** So a route can keep the `modelFor` import in one place when it needs a raw model. */
export { modelFor };
