/**
 * Connections (spec §3.5; task 1.16): how Perch reaches a service on someone's behalf.
 *
 * The invariant this file exists to keep (AGENTS.md §1.6): a connection's token goes vault → here
 * → the one upstream request that needs it, and nowhere else. No caller, engine, bot, transcript,
 * or log line ever sees one. `tokenFor` is the single door, and everything that needs to call a
 * provider goes through it.
 */
import type { Bus } from "@perch/bus";
import {
  apiBaseOf,
  callbackUrl,
  exchangeCode,
  type FetchLike,
  GitHubAppError,
  installationToken,
  type Manifest,
  parseManifest,
  startAuthorization,
} from "@perch/connect";
import { MANIFESTS } from "@perch/connectors";
import type {
  Connection,
  ConnectionKind,
  ConnectionMetadata,
  ConnectionOwner,
  Db,
  OauthClient,
} from "@perch/db";
import type { Vault } from "@perch/vault";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  deleteConnection,
  findOauthClient,
  getConnection,
  insertConnection,
  listConnections,
  setConnectionStatus,
  upsertOauthClient,
} from "../repos/connections.ts";

export type ConnectionsDeps = {
  db: Db;
  bus: Bus;
  vault: Vault;
  log: Logger;
  /** Every callback, the CIMD document, and a webhook URL is built from this (spec §3.1). */
  publicUrl: string;
  /** Overridable so a test can stand in for a provider. */
  fetch?: FetchLike;
};

/** A connection as a caller may see it: everything except the secret. */
export type ConnectionView = {
  id: string;
  provider: string;
  providerName: string;
  kind: ConnectionKind;
  ownerType: ConnectionOwner;
  ownerId: string;
  scopes: string[];
  status: string;
  account: string | null;
  /** The last few characters of a pasted token, so two are tellable apart. Never the whole thing. */
  hint: string | null;
  expiresAt: string | null;
  createdAt: string;
};

/** What a person sees of a token: the first two and last four characters of anything long enough. */
export function tokenHint(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length < 8) return null;
  return `${trimmed.slice(0, 2)}…${trimmed.slice(-4)}`;
}

/** What a GitHub App connection stores instead of a token: the app's id and its private key. */
export type AppSecret = { appId: string; privateKey: string };

const AAD = (workspaceId: string) => `connection:${workspaceId}`;

export class ConnectionsService {
  private readonly manifests = new Map<string, Manifest>();
  /** Authorizations in flight, by state (see Pending below). */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: ConnectionsDeps) {
    for (const [id, source] of Object.entries(MANIFESTS)) {
      try {
        this.manifests.set(id, parseManifest(source));
      } catch (error) {
        // A manifest that does not parse is a build problem, not a request problem: say so loudly
        // and carry on without that provider rather than refusing to boot.
        deps.log.error({ err: error, connector: id }, "a connector manifest could not be read");
      }
    }
  }

  /** Every provider this instance can connect to. */
  providers(): Manifest[] {
    return [...this.manifests.values()];
  }

  manifest(provider: string): Manifest {
    const found = this.manifests.get(provider);
    if (!found) {
      throw PerchError.validation(`unknown provider ${provider}`, {
        provider,
        known: [...this.manifests.keys()],
      });
    }
    return found;
  }

  /** Where this provider sends someone back (spec §7.1), and where it posts events. */
  callback(provider: string): string {
    return callbackUrl(this.deps.publicUrl, provider);
  }

  connections(workspaceId: string, userId: string): Promise<Connection[]> {
    return listConnections(this.deps.db, workspaceId, userId);
  }

  view(row: Connection): ConnectionView {
    return {
      id: row.id,
      provider: row.provider,
      providerName: this.manifests.get(row.provider)?.name ?? row.provider,
      kind: row.kind,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      scopes: row.scopes,
      status: row.status,
      account: row.metadata.account ?? null,
      hint: row.metadata.hint ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * The paste lane (spec §3.5, "always available"): a personal access token or an API key. It is
   * checked against the provider before it is kept, so a typo is caught here rather than at the
   * first clone.
   */
  async addToken(input: {
    workspaceId: string;
    userId: string;
    provider: string;
    token: string;
    ownerType: ConnectionOwner;
    apiBase?: string;
    by: ActorContext;
  }): Promise<Connection> {
    const manifest = this.manifest(input.provider);
    const token = input.token.trim();
    if (!token) throw PerchError.validation("a token connection needs a token");
    if (
      manifest.token_prefix.length > 0 &&
      !manifest.token_prefix.some((prefix: string) => token.startsWith(prefix))
    ) {
      // Not a hard refusal in the provider's eyes, but almost always a paste from the wrong field.
      throw PerchError.validation(`that does not look like a ${manifest.name} token`, {
        expected: manifest.token_prefix,
      });
    }
    const checked = await this.check(manifest, token, input.apiBase);
    return this.store({
      ...input,
      kind: "token",
      secret: token,
      scopes: checked.scopes,
      expiresAt: null,
      metadata: {
        ...(checked.account ? { account: checked.account } : {}),
        ...(tokenHint(token) ? { hint: tokenHint(token) as string } : {}),
        ...(input.apiBase ? { apiBase: input.apiBase } : {}),
      },
    });
  }

  /**
   * The GitHub App lane (spec §3.5): Perch keeps the app's private key and mints a short-lived
   * installation token for each call. The key is the only long-lived secret, and it never leaves
   * the vault except inside `tokenFor`.
   */
  async addGitHubApp(input: {
    workspaceId: string;
    userId: string;
    provider: string;
    appId: string;
    privateKey: string;
    installationId: string;
    ownerType: ConnectionOwner;
    apiBase?: string;
    by: ActorContext;
  }): Promise<Connection> {
    const manifest = this.manifest(input.provider);
    if (!manifest.auth.includes("github_app")) {
      throw PerchError.validation(`${manifest.name} has no app lane`);
    }
    const secret: AppSecret = { appId: input.appId.trim(), privateKey: input.privateKey };
    if (!secret.appId) throw PerchError.validation("an app connection needs the app id");
    // Minting once proves the key, the app id, and the installation all line up before it is kept.
    let minted: { token: string; expiresAt: Date };
    try {
      minted = await installationToken({
        appId: secret.appId,
        privateKeyPem: secret.privateKey,
        installationId: input.installationId,
        apiBase: apiBaseOf(manifest, input.apiBase),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
    } catch (error) {
      throw this.upstream(error, manifest);
    }
    const checked = await this.check(manifest, minted.token, input.apiBase).catch(() => ({
      account: null,
      scopes: [] as string[],
    }));
    return this.store({
      ...input,
      kind: "github_app",
      secret: JSON.stringify(secret),
      scopes: checked.scopes,
      expiresAt: null,
      metadata: {
        installationId: input.installationId,
        ...(checked.account ? { account: checked.account } : {}),
        ...(input.apiBase ? { apiBase: input.apiBase } : {}),
      },
    });
  }

  /**
   * The OAuth2 lane (spec §3.5): where to send someone, remembering the state and verifier the
   * callback will be checked against. The app's own credentials come from oauth_clients.
   */
  async startOAuth(input: {
    workspaceId: string;
    userId: string;
    provider: string;
    ownerType: ConnectionOwner;
    scopes?: string[];
  }): Promise<{ url: string; state: string }> {
    const manifest = this.manifest(input.provider);
    if (!manifest.oauth) {
      throw PerchError.validation(`${manifest.name} has no OAuth lane; paste a token instead`);
    }
    const client = await findOauthClient(this.deps.db, input.workspaceId, input.provider);
    if (!client) {
      throw PerchError.validation(
        `no ${manifest.name} app is registered here; add one under Use my own app`,
        { provider: input.provider },
      );
    }
    const started = startAuthorization({
      manifest,
      clientId: client.clientId,
      redirectUri: this.callback(input.provider),
      ...(input.scopes ? { scopes: input.scopes } : {}),
    });
    this.pending.set(started.state, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      codeVerifier: started.codeVerifier,
      ownerType: input.ownerType,
      expiresAt: Date.now() + PENDING_MS,
    });
    this.sweep();
    return { url: started.url, state: started.state };
  }

  /**
   * The other half: the code comes back, is traded for tokens, and becomes a connection. The state
   * is single-use — a replayed callback finds nothing, which is the point of keeping it.
   */
  async finishOAuth(input: { state: string; code: string; by: ActorContext }): Promise<Connection> {
    const pending = this.pending.get(input.state);
    this.pending.delete(input.state);
    if (!pending || pending.expiresAt < Date.now()) {
      throw PerchError.validation("this authorization is not one Perch is waiting for");
    }
    const manifest = this.manifest(pending.provider);
    const client = await findOauthClient(this.deps.db, pending.workspaceId, pending.provider);
    if (!client) throw PerchError.validation("the app this started with is gone");
    const secret = client.ciphertextSecret
      ? await this.deps.vault
          .decryptString(client.ciphertextSecret, AAD(pending.workspaceId))
          .catch(() => null)
      : null;
    const tokens = await exchangeCode({
      manifest,
      clientId: client.clientId,
      clientSecret: secret,
      redirectUri: this.callback(pending.provider),
      code: input.code,
      codeVerifier: pending.codeVerifier,
    });
    const checked = await this.check(manifest, tokens.accessToken).catch(() => ({
      account: null,
      scopes: [] as string[],
    }));
    return this.store({
      workspaceId: pending.workspaceId,
      userId: pending.userId,
      provider: pending.provider,
      kind: "oauth2",
      ownerType: pending.ownerType,
      // Both halves together: a refresh needs the pair, and neither is ever read back out.
      secret: JSON.stringify({
        access: tokens.accessToken,
        ...(tokens.refreshToken ? { refresh: tokens.refreshToken } : {}),
      }),
      scopes: tokens.scopes.length > 0 ? tokens.scopes : checked.scopes,
      expiresAt: tokens.expiresAt ?? null,
      metadata: checked.account ? { account: checked.account } : {},
      by: input.by,
    });
  }

  /** The pre-registered lane (spec §3.5): an app this workspace registered with a provider. */
  async registerApp(input: {
    workspaceId: string;
    provider: string;
    clientId: string;
    clientSecret?: string;
  }): Promise<OauthClient> {
    this.manifest(input.provider);
    return upsertOauthClient(this.deps.db, {
      workspaceId: input.workspaceId,
      provider: input.provider,
      clientId: input.clientId.trim(),
      ciphertextSecret: input.clientSecret
        ? await this.deps.vault.encrypt(input.clientSecret, AAD(input.workspaceId))
        : null,
      redirectUri: this.callback(input.provider),
    });
  }

  /** Forgets authorizations nobody came back from, so the map cannot grow without bound. */
  private sweep(): void {
    const now = Date.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt < now) this.pending.delete(state);
    }
  }

  /** A connection the person may use here, or nothing (§3.5: personal ones are theirs alone). */
  async connectionFor(workspaceId: string, userId: string, id: string): Promise<Connection | null> {
    const row = await getConnection(this.deps.db, id);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.ownerType === "user" && row.ownerId !== userId) return null;
    return row;
  }

  /**
   * The token to call this provider with, right now. For a pasted token that is what was pasted;
   * for an app it is an installation token minted for this call. The only place a secret leaves
   * the vault, and it is never returned to a caller — only handed to the code making the request.
   */
  async tokenFor(row: Connection): Promise<string> {
    const manifest = this.manifest(row.provider);
    const secret = await this.secret(row);
    if (row.kind === "oauth2") {
      try {
        return (JSON.parse(secret) as { access: string }).access;
      } catch {
        throw new PerchError(
          "upstream_failed",
          "this connection could not be read",
          undefined,
          502,
        );
      }
    }
    if (row.kind !== "github_app") return secret;
    let app: AppSecret;
    try {
      app = JSON.parse(secret) as AppSecret;
    } catch {
      throw new PerchError("upstream_failed", "this connection could not be read", undefined, 502);
    }
    const installation = row.metadata.installationId;
    if (!installation) {
      throw PerchError.validation("this app connection has no installation");
    }
    try {
      const minted = await installationToken({
        appId: app.appId,
        privateKeyPem: app.privateKey,
        installationId: installation,
        apiBase: apiBaseOf(manifest, row.metadata.apiBase),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      return minted.token;
    } catch (error) {
      await setConnectionStatus(this.deps.db, row.id, "invalid");
      throw this.upstream(error, manifest);
    }
  }

  /** Does it still work? The manifest's test call, which is also what the card's Test button runs. */
  async test(row: Connection): Promise<{ account: string | null; scopes: string[] }> {
    const manifest = this.manifest(row.provider);
    const token = await this.tokenFor(row);
    try {
      const checked = await this.check(manifest, token, row.metadata.apiBase);
      if (row.status !== "active") await setConnectionStatus(this.deps.db, row.id, "active");
      return checked;
    } catch (error) {
      if (error instanceof PerchError && error.status === 502) {
        await setConnectionStatus(this.deps.db, row.id, "invalid");
      }
      throw error;
    }
  }

  async remove(row: Connection, by: ActorContext): Promise<void> {
    await deleteConnection(this.deps.db, row.id);
    await this.deps.bus.publish(
      "connection.revoked",
      { workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider },
      { ...by, topics: [`ws:${row.workspaceId}`] },
    );
  }

  /** The manifest's test call. The token goes out in one header and appears nowhere else. */
  private async check(
    manifest: Manifest,
    token: string,
    apiBase?: string | null,
  ): Promise<{ account: string | null; scopes: string[] }> {
    const base = apiBaseOf(manifest, apiBase);
    const call: FetchLike = this.deps.fetch ?? fetch;
    let response: Response;
    try {
      response = await call(`${base}${manifest.test_path}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": "perch",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new PerchError(
        "upstream_failed",
        `could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        502,
      );
    }
    if (!response.ok) {
      throw new PerchError(
        "upstream_failed",
        `${base} answered ${response.status} ${response.statusText}`.trim(),
        undefined,
        502,
      );
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const field = manifest.account_field;
    const account = field && typeof body?.[field] === "string" ? (body[field] as string) : null;
    // GitHub reports a token's scopes in a header; providers that do not simply have none to show.
    const scopes = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    return { account, scopes };
  }

  private async store(input: {
    workspaceId: string;
    userId: string;
    provider: string;
    kind: ConnectionKind;
    ownerType: ConnectionOwner;
    secret: string;
    scopes: string[];
    expiresAt: Date | null;
    metadata: ConnectionMetadata;
    by: ActorContext;
  }): Promise<Connection> {
    const row = await insertConnection(this.deps.db, {
      workspaceId: input.workspaceId,
      ownerType: input.ownerType,
      ownerId: input.userId,
      provider: input.provider,
      kind: input.kind,
      ciphertext: await this.deps.vault.encrypt(input.secret, AAD(input.workspaceId)),
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
    });
    await this.deps.bus.publish(
      "connection.created",
      { workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider },
      { ...input.by, topics: [`ws:${row.workspaceId}`] },
    );
    return row;
  }

  private async secret(row: Connection): Promise<string> {
    try {
      return await this.deps.vault.decryptString(row.ciphertext, AAD(row.workspaceId));
    } catch (error) {
      this.deps.log.error(
        { err: error, connectionId: row.id },
        "a connection could not be decrypted",
      );
      throw new PerchError("upstream_failed", "this connection could not be read", undefined, 502);
    }
  }

  /** A provider's refusal, without ever repeating the request that carried the secret. */
  private upstream(error: unknown, manifest: Manifest): PerchError {
    if (error instanceof GitHubAppError) {
      return new PerchError("upstream_failed", error.message, undefined, 502);
    }
    return new PerchError(
      "upstream_failed",
      `${manifest.name} refused: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      502,
    );
  }
}

/**
 * A pending authorization (spec §3.5 PKCE): the state and verifier a callback is checked against.
 * In memory with a short life, like presence and rate limits (§3.1) — an authorization that
 * outlives an api restart is an authorization nobody is waiting on any more.
 */
export type Pending = {
  workspaceId: string;
  userId: string;
  provider: string;
  codeVerifier: string;
  ownerType: ConnectionOwner;
  expiresAt: number;
};

/** How long someone has to finish at the provider before the state is forgotten. */
export const PENDING_MS = 10 * 60_000;
