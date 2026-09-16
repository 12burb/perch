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
  authorizationServer,
  CIMD_PATH,
  callbackUrl,
  chooseClient,
  clientMetadata,
  exchangeCode,
  exchangeCodeAt,
  type FetchLike,
  GitHubAppError,
  installationToken,
  type Manifest,
  mcpUrlOf,
  parseManifest,
  protectedResource,
  type RegistrationLane,
  startAuthorization,
  startAuthorizationAt,
} from "@perch/connect";
import { MANIFESTS } from "@perch/connectors";
import type {
  Connection,
  ConnectionGrant,
  ConnectionKind,
  ConnectionMetadata,
  ConnectionOwner,
  Db,
  GrantSubject,
  OauthClient,
} from "@perch/db";
import type { Vault } from "@perch/vault";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  deleteConnection,
  deleteGrant,
  findOauthClient,
  getConnection,
  insertConnection,
  listConnections,
  listGrants,
  setConnectionStatus,
  upsertGrant,
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
    mcpUrl?: string;
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
        ...(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {}),
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
    mcpUrl?: string;
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
        ...(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {}),
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
    // The MCP lane traded at endpoints discovery found, not at the manifest's (task 2.14).
    if (pending.mcp) return this.finishMcpOAuth(manifest, pending, input);
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

  /**
   * The MCP lane's other half: the code is traded at the token endpoint discovery found, with the
   * resource indicator that says which MCP server the token is for (RFC 8707).
   */
  private async finishMcpOAuth(
    manifest: Manifest,
    pending: Pending,
    input: { code: string; by: ActorContext },
  ): Promise<Connection> {
    const mcp = pending.mcp;
    if (!mcp) throw PerchError.validation("this authorization is not one Perch is waiting for");
    const tokens = await exchangeCodeAt({
      tokenUrl: mcp.tokenEndpoint,
      clientId: mcp.clientId,
      clientSecret: mcp.clientSecret ?? null,
      redirectUri: this.callback(pending.provider),
      code: input.code,
      codeVerifier: pending.codeVerifier,
      resource: mcp.resource,
      ...(this.deps.fetch ? { fetcher: this.deps.fetch } : {}),
    }).catch((error: unknown) => {
      throw PerchError.validation(
        `${manifest.name} refused the code: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.store({
      workspaceId: pending.workspaceId,
      userId: pending.userId,
      provider: pending.provider,
      kind: "mcp_oauth",
      ownerType: pending.ownerType,
      secret: JSON.stringify({
        access: tokens.accessToken,
        ...(tokens.refreshToken ? { refresh: tokens.refreshToken } : {}),
      }),
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt ?? null,
      // Everything here is public: which lane, which server, which client. The secret is vaulted.
      metadata: {
        lane: mcp.lane,
        issuer: mcp.issuer,
        tokenEndpoint: mcp.tokenEndpoint,
        clientId: mcp.clientId,
        mcpUrl: mcp.resource,
      },
      by: input.by,
    });
  }

  /**
   * The MCP lane (spec §3.5 "MCP OAuth discovery via RFC 9728 → RFC 8414/OIDC metadata → PKCE";
   * task 2.14). Ask the provider's MCP server which authorization server guards it, ask that server
   * where its endpoints are, and be somebody it will talk to — an app registered here, this
   * instance's own metadata document, or a client registered on the spot.
   */
  async startMcpOAuth(input: {
    workspaceId: string;
    userId: string;
    provider: string;
    ownerType: ConnectionOwner;
    scopes?: string[];
    /** A self-hosted instance of this provider, the way `api_base` overrides its REST host. */
    mcpUrl?: string | undefined;
  }): Promise<{ url: string; state: string; lane: RegistrationLane }> {
    const manifest = this.manifest(input.provider);
    const mcpUrl = input.mcpUrl?.trim() || mcpUrlOf(manifest);
    if (!mcpUrl) {
      throw PerchError.validation(`${manifest.name} has no MCP server; paste a token instead`);
    }
    const fetcher: FetchLike = this.deps.fetch ?? fetch;
    const resource = await protectedResource(mcpUrl, fetcher);
    const issuer = resource?.authorization_servers[0];
    if (!issuer) {
      throw PerchError.validation(
        `${manifest.name}'s MCP server does not say how to authorize; paste a token instead`,
      );
    }
    const server = await authorizationServer(issuer, fetcher);
    if (!server) {
      throw PerchError.validation(`${issuer} does not publish its endpoints`);
    }
    const registered = await findOauthClient(this.deps.db, input.workspaceId, input.provider);
    const secret = registered?.ciphertextSecret
      ? await this.deps.vault
          .decryptString(registered.ciphertextSecret, AAD(input.workspaceId))
          .catch(() => null)
      : null;
    const choice = await chooseClient({
      server,
      ...(registered
        ? { preRegistered: { clientId: registered.clientId, clientSecret: secret } }
        : {}),
      cimdUrl: `${this.deps.publicUrl.replace(/\/+$/, "")}${CIMD_PATH}`,
      registration: registrationFor(
        clientMetadata({
          publicUrl: this.deps.publicUrl,
          version: "1",
          providers: [input.provider],
        }),
      ),
      fetcher,
    });
    const started = startAuthorizationAt({
      authorizeUrl: server.authorization_endpoint,
      clientId: choice.clientId,
      redirectUri: this.callback(input.provider),
      scopes: input.scopes ?? resource?.scopes_supported ?? server.scopes_supported ?? [],
      resource: resource?.resource ?? mcpUrl,
    });
    this.pending.set(started.state, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      codeVerifier: started.codeVerifier,
      ownerType: input.ownerType,
      expiresAt: Date.now() + PENDING_MS,
      mcp: {
        lane: choice.lane,
        clientId: choice.clientId,
        ...(choice.clientSecret ? { clientSecret: choice.clientSecret } : {}),
        issuer,
        tokenEndpoint: server.token_endpoint,
        resource: resource?.resource ?? mcpUrl,
      },
    });
    this.sweep();
    return { url: started.url, state: started.state, lane: choice.lane };
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

  /**
   * Who may use a connection, and for what (spec §3.5 "grants UI … on-behalf-of rule"; task 2.14).
   *
   * The rule this method exists for: a connection that belongs to a person is that person's. A bot
   * the whole workspace can talk to may not simply be handed it — whoever asked the bot would be
   * spending somebody else's access without either of them saying so. Such a bot may use it only
   * on that person's behalf (`obo`), and only when they are the one who invoked it; anything shared
   * that wants more runs on a workspace connection, which is what admins grant explicitly.
   */
  async grant(input: {
    connection: Connection;
    subjectType: GrantSubject;
    subjectId: string;
    allowedTools?: string[] | null;
    /** Tools this subject may only use once a person has said yes (spec §3.5; task 3.6). */
    requiresPermission?: string[] | null;
    channels?: string[] | null;
    obo?: boolean;
    grantedBy: string;
    /** Whether the subject is something more than one person can reach (a workspace-visible bot). */
    shared: boolean;
    by: ActorContext;
  }): Promise<ConnectionGrant> {
    const personal = input.connection.ownerType === "user";
    const obo = input.obo ?? personal;
    if (personal && input.shared && !obo) {
      throw PerchError.forbidden(
        "this connection is one person's; a shared bot may use it only on their behalf",
        { rule: "obo" },
      );
    }
    if (!personal && obo && input.subjectType === "bot") {
      // A workspace connection has no one person to act for; obo would be a promise nobody keeps.
      throw PerchError.validation(
        "a workspace connection is used as itself, not on somebody's behalf",
      );
    }
    const row = await upsertGrant(this.deps.db, {
      connectionId: input.connection.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      allowedTools: input.allowedTools ?? null,
      requiresPermission: input.requiresPermission ?? null,
      channels: input.channels ?? null,
      obo,
      grantedBy: input.grantedBy,
    });
    await this.deps.bus.publish(
      "connection.grant_added",
      {
        workspaceId: input.connection.workspaceId,
        connectionId: input.connection.id,
        grantId: row.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
      input.by,
    );
    return row;
  }

  grants(connectionId: string): Promise<ConnectionGrant[]> {
    return listGrants(this.deps.db, connectionId);
  }

  async revoke(connection: Connection, grantId: string, by: ActorContext): Promise<boolean> {
    const gone = await deleteGrant(this.deps.db, grantId);
    if (gone) {
      await this.deps.bus.publish(
        "connection.grant_removed",
        {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          grantId,
        },
        by,
      );
    }
    return gone;
  }

  /**
   * Whether this subject may use this connection right now (task 2.14). An `obo` grant is only good
   * for the person the connection belongs to: a shared bot invoked by somebody else is refused,
   * which is the rule §3.5 asks for, checked where it is used rather than only where it is given.
   */
  async mayUse(input: {
    connection: Connection;
    subjectType: GrantSubject;
    subjectId: string;
    /**
     * Who set this off: the person whose turn it is, or `null` when nobody's — an external bot
     * with a token of its own is a program, not somebody's turn, and an `obo` grant is exactly
     * the grant that needs a somebody (task 3.3).
     */
    invokedBy: string | null;
  }): Promise<
    | { ok: true; allowedTools: string[] | null; requiresPermission: string[] | null }
    | { ok: false; reason: string }
  > {
    const grants = await listGrants(this.deps.db, input.connection.id);
    const granted = grants.find(
      (one) => one.subjectType === input.subjectType && one.subjectId === input.subjectId,
    );
    if (!granted) return { ok: false, reason: "this connection has not been granted to it" };
    if (granted.obo && input.connection.ownerId !== input.invokedBy) {
      return {
        ok: false,
        reason: "this connection is one person's, and they are not the one asking",
      };
    }
    return {
      ok: true,
      allowedTools: granted.allowedTools ?? null,
      requiresPermission: granted.requiresPermission ?? null,
    };
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
  /** The MCP lane (task 2.14): the endpoints discovery found, and the client it came by. */
  mcp?: {
    lane: RegistrationLane;
    clientId: string;
    clientSecret?: string | undefined;
    issuer: string;
    tokenEndpoint: string;
    resource: string;
  };
};

/**
 * What RFC 7591 is sent: the same description the metadata document publishes, without the
 * `client_id` it declares — that one is ours to claim only in the CIMD lane.
 */
function registrationFor(metadata: Record<string, unknown>): Record<string, unknown> {
  const { client_id: _declared, ...rest } = metadata;
  return rest;
}

/** How long someone has to finish at the provider before the state is forgotten. */
export const PENDING_MS = 10 * 60_000;
