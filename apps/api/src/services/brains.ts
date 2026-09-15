/**
 * Brains (spec §3.4, §3.6 lane A; task 1.15): the credentials a workspace can run models on, the
 * profiles that name a model to run, and the catalog each credential can actually reach.
 *
 * The invariant this file exists to keep (AGENTS.md §1.6): a secret goes vault → here → either the
 * provider's own Authorization header or an engine's environment, and nowhere else. Nothing a
 * caller receives, and no log line, ever carries one — the API answers with a hint like `sk…4f2a`.
 */
import type { Bus } from "@perch/bus";
import type {
  CredentialKind,
  CredentialScope,
  Db,
  ModelProfile,
  ProfileDefault,
  ProviderCredential,
} from "@perch/db";
import {
  CatalogError,
  type CatalogModel,
  detectOllama,
  type LanguageModel,
  listModels,
  modelFor,
  PROVIDERS,
  providerInfo,
} from "@perch/gateway";
import type { Vault } from "@perch/vault";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  defaultProfile,
  deleteCredential,
  deleteProfile,
  getCredential,
  getProfile,
  insertCredential,
  insertProfile,
  listCredentials,
  listProfiles,
  makeDefault,
  profilesUsing,
  setCredentialStatus,
} from "../repos/brains.ts";

export type BrainsDeps = {
  db: Db;
  bus: Bus;
  vault: Vault;
  log: Logger;
  /** Where a local Ollama might be, beyond the default port (PERCH_OLLAMA_URL). */
  ollamaUrls?: readonly string[];
};

/** A credential as a caller may see it: everything except the secret. */
export type CredentialView = {
  id: string;
  provider: string;
  providerName: string;
  kind: CredentialKind;
  scope: CredentialScope;
  label: string;
  baseUrl: string | null;
  status: string;
  ownerId: string;
  /** The last few characters of a key, so a person can tell two apart. Never the whole thing. */
  hint: string | null;
  createdAt: string;
};

/** What a person sees of a key: the first two and last four characters of anything long enough. */
export function secretHint(secret: string): string | null {
  const trimmed = secret.trim();
  if (trimmed.length < 8) return null;
  return `${trimmed.slice(0, 2)}…${trimmed.slice(-4)}`;
}

const AAD = (workspaceId: string) => `provider_credential:${workspaceId}`;

export class BrainsService {
  constructor(private readonly deps: BrainsDeps) {}

  /** The providers Perch knows, plus a local Ollama if one is answering right now. */
  async providers(): Promise<{
    providers: typeof PROVIDERS;
    ollama: { baseUrl: string; models: CatalogModel[] } | null;
  }> {
    const ollama = await detectOllama({
      ...(this.deps.ollamaUrls ? { urls: this.deps.ollamaUrls } : {}),
    }).catch(() => null);
    return { providers: PROVIDERS, ollama };
  }

  credentials(workspaceId: string, userId: string): Promise<ProviderCredential[]> {
    return listCredentials(this.deps.db, workspaceId, userId);
  }

  view(row: ProviderCredential): CredentialView {
    return {
      id: row.id,
      provider: row.provider,
      providerName: providerInfo(row.provider)?.name ?? row.provider,
      kind: row.kind,
      scope: row.scope,
      label: row.label,
      baseUrl: row.baseUrl,
      status: row.status,
      ownerId: row.ownerId,
      hint: row.hint,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Adds a key or an endpoint. An endpoint may have no secret at all (a laptop's Ollama); a key
   * provider must have one. The secret is encrypted before it touches the database.
   */
  async addCredential(input: {
    workspaceId: string;
    userId: string;
    provider: string;
    kind: CredentialKind;
    scope: CredentialScope;
    label: string;
    secret?: string;
    baseUrl?: string;
    by: ActorContext;
  }): Promise<ProviderCredential> {
    const info = providerInfo(input.provider);
    if (!info) {
      throw PerchError.validation(`unknown provider ${input.provider}`, {
        provider: input.provider,
        known: PROVIDERS.map((p) => p.id),
      });
    }
    const secret = input.secret?.trim() ?? "";
    if (input.kind === "api_key" && !secret) {
      throw PerchError.validation("an API key credential needs a key");
    }
    const baseUrl = input.baseUrl?.trim() || null;
    if (input.kind === "endpoint" && !baseUrl && !info.baseUrl) {
      throw PerchError.validation("an endpoint credential needs a base URL");
    }
    const row = await insertCredential(this.deps.db, {
      workspaceId: input.workspaceId,
      scope: input.scope,
      ownerId: input.userId,
      provider: input.provider,
      kind: input.kind,
      ciphertext: await this.deps.vault.encrypt(secret, AAD(input.workspaceId)),
      label: input.label.trim(),
      hint: secret ? secretHint(secret) : null,
      baseUrl,
    });
    await this.deps.bus.publish(
      "connection.created",
      { workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider },
      { ...input.by, topics: [`ws:${row.workspaceId}`] },
    );
    return row;
  }

  /** A credential the person may use here, or nothing. */
  async credentialFor(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<ProviderCredential | null> {
    const row = await getCredential(this.deps.db, id);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.scope === "user" && row.ownerId !== userId) return null;
    return row;
  }

  async removeCredential(
    row: ProviderCredential,
    by: ActorContext,
  ): Promise<{ profiles: string[] }> {
    const affected = await profilesUsing(this.deps.db, row.id);
    await deleteCredential(this.deps.db, row.id);
    await this.deps.bus.publish(
      "connection.revoked",
      { workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider },
      { ...by, topics: [`ws:${row.workspaceId}`] },
    );
    return { profiles: affected.map((profile) => profile.name) };
  }

  /**
   * What this credential can reach, asked of the provider. The answer doubles as the test button:
   * a provider that lists models is a provider that took the key.
   */
  async models(row: ProviderCredential): Promise<CatalogModel[]> {
    const secret = await this.secret(row);
    try {
      const models = await listModels({
        provider: row.provider,
        baseUrl: row.baseUrl,
        apiKey: secret || null,
      });
      if (row.status !== "active") await setCredentialStatus(this.deps.db, row.id, "active");
      return models;
    } catch (error) {
      if (error instanceof CatalogError) {
        // 401/403 means the key is wrong; anything else may be the network, so the row stands.
        if (error.status === 401 || error.status === 403) {
          await setCredentialStatus(this.deps.db, row.id, "invalid");
        }
        throw new PerchError("upstream_failed", error.message, undefined, 502);
      }
      throw error;
    }
  }

  profiles(workspaceId: string): Promise<ModelProfile[]> {
    return listProfiles(this.deps.db, workspaceId);
  }

  async addProfile(input: {
    workspaceId: string;
    userId: string;
    name: string;
    provider: string;
    modelId: string;
    credentialId?: string;
    defaultFor?: ProfileDefault;
    by: ActorContext;
  }): Promise<ModelProfile> {
    if (input.credentialId) {
      const credential = await this.credentialFor(
        input.workspaceId,
        input.userId,
        input.credentialId,
      );
      if (!credential) throw PerchError.notFound("credential");
      if (credential.provider !== input.provider) {
        throw PerchError.validation("the credential is for another provider", {
          credential: credential.provider,
          profile: input.provider,
        });
      }
    }
    const row = await insertProfile(this.deps.db, {
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      provider: input.provider,
      modelId: input.modelId.trim(),
      credentialId: input.credentialId ?? null,
      defaultFor: null,
    });
    if (input.defaultFor) {
      const promoted = await makeDefault(this.deps.db, input.workspaceId, row.id, input.defaultFor);
      return promoted ?? row;
    }
    return row;
  }

  async profileFor(workspaceId: string, id: string): Promise<ModelProfile | null> {
    const row = await getProfile(this.deps.db, id);
    return row && row.workspaceId === workspaceId ? row : null;
  }

  setDefault(workspaceId: string, id: string, kind: ProfileDefault): Promise<ModelProfile | null> {
    return makeDefault(this.deps.db, workspaceId, id, kind);
  }

  async removeProfile(row: ModelProfile): Promise<void> {
    await deleteProfile(this.deps.db, row.id);
  }

  defaultFor(workspaceId: string, kind: ProfileDefault): Promise<ModelProfile | null> {
    return defaultProfile(this.deps.db, workspaceId, kind);
  }

  /**
   * What an engine needs in its environment to run this profile (spec §3.4 fidelity rule: engines
   * get native provider credentials). The only place a secret leaves this service, and it goes
   * straight into `session.create {env}` — never to a client, never to a log line.
   */
  async engineEnv(profile: ModelProfile, userId: string): Promise<Record<string, string>> {
    if (!profile.credentialId) return {};
    const credential = await this.credentialFor(profile.workspaceId, userId, profile.credentialId);
    if (!credential) {
      throw PerchError.validation("this brain's credential is not yours to use", {
        profile: profile.name,
      });
    }
    const info = providerInfo(credential.provider);
    const secret = await this.secret(credential);
    const env: Record<string, string> = {};
    if (info?.envVar && secret) env[info.envVar] = secret;
    const base = credential.baseUrl?.trim();
    if (base) {
      // OpenAI-compatible engines read the base URL from the provider's own variable where it has
      // one, and from OPENAI_BASE_URL when the endpoint speaks that dialect.
      if (credential.provider === "ollama") env.OLLAMA_HOST = base.replace(/\/v1$/, "");
      else env.OPENAI_BASE_URL = base;
    }
    return env;
  }

  /**
   * The brain as something that can be called (task 2.6). The key is decrypted here, handed to the
   * gateway, and held by the model object for the length of the call — it never reaches a bot, a
   * prompt, a log line or a client (AGENTS §1.6).
   *
   * `userId` is who the call is on behalf of: a bot's owner, or the person asking. A user-scoped
   * credential is theirs alone, which is what stops a shared bot spending somebody's personal key.
   */
  async languageModel(profile: ModelProfile, userId: string): Promise<LanguageModel> {
    if (!profile.credentialId) {
      // No credential: an endpoint that needs none (a local Ollama on its default port).
      return modelFor({ provider: profile.provider, modelId: profile.modelId });
    }
    const credential = await this.credentialFor(profile.workspaceId, userId, profile.credentialId);
    if (!credential) {
      throw PerchError.validation("this brain's credential is not yours to use", {
        profile: profile.name,
      });
    }
    return modelFor({
      provider: credential.provider,
      modelId: profile.modelId,
      baseUrl: credential.baseUrl,
      apiKey: await this.secret(credential),
    });
  }

  /**
   * The credential's key, decrypted for one call. Public so the repo index can embed with the
   * workspace's brain (task 2.17); it is handed to a provider request and nowhere else.
   */
  async secretOf(row: ProviderCredential): Promise<string> {
    return this.secret(row);
  }

  private async secret(row: ProviderCredential): Promise<string> {
    try {
      return await this.deps.vault.decryptString(row.ciphertext, AAD(row.workspaceId));
    } catch (error) {
      this.deps.log.error(
        { err: error, credentialId: row.id },
        "a credential could not be decrypted",
      );
      throw new PerchError("upstream_failed", "this credential could not be read", undefined, 502);
    }
  }
}
