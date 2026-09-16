/**
 * The plain OAuth2 lane (spec §3.5: "plain OAuth2 providers via Arctic driven by
 * connectors/<provider>/manifest.yaml"; task 1.16).
 *
 * Arctic speaks the authorization-code flow with PKCE; the manifest says where a provider's
 * endpoints are and which scopes to ask for, so a new provider needs no code. The client secret,
 * when the provider insisted on one, comes from the vault at the moment of the exchange.
 */
import { CodeChallengeMethod, generateCodeVerifier, generateState, OAuth2Client } from "arctic";
import type { Manifest } from "./manifest.ts";

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export type OAuthStart = {
  /** Where to send the person. */
  url: string;
  /** Kept server-side until the callback proves it came back unchanged. */
  state: string;
  codeVerifier: string;
};

function clientFor(manifest: Manifest, clientId: string, redirectUri: string): OAuth2Client {
  if (!manifest.oauth) throw new OAuthError(`${manifest.name} has no OAuth2 lane`);
  return new OAuth2Client(clientId, null, redirectUri);
}

/** The URL to send someone to, plus the state and verifier the callback will be checked against. */
export function startAuthorization(options: {
  manifest: Manifest;
  clientId: string;
  redirectUri: string;
  /** Overrides the manifest's default scopes, when a caller wants fewer. */
  scopes?: readonly string[];
}): OAuthStart {
  const { manifest } = options;
  if (!manifest.oauth) throw new OAuthError(`${manifest.name} has no OAuth2 lane`);
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const client = clientFor(manifest, options.clientId, options.redirectUri);
  const scopes = [...(options.scopes ?? manifest.oauth.scopes)];
  const url = client.createAuthorizationURLWithPKCE(
    manifest.oauth.authorize_url,
    state,
    CodeChallengeMethod.S256,
    codeVerifier,
    // Arctic joins with spaces; a provider that wants another separator gets it below.
    manifest.oauth.scope_separator === " " ? scopes : [],
  );
  if (manifest.oauth.scope_separator !== " " && scopes.length > 0) {
    url.searchParams.set("scope", scopes.join(manifest.oauth.scope_separator));
  }
  return { url: url.toString(), state, codeVerifier };
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
};

/** Trades the code for tokens. Nothing here is logged: the answer is a secret in both directions. */
export async function exchangeCode(options: {
  manifest: Manifest;
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<OAuthTokens> {
  const { manifest } = options;
  if (!manifest.oauth) throw new OAuthError(`${manifest.name} has no OAuth2 lane`);
  const client = new OAuth2Client(
    options.clientId,
    options.clientSecret ?? null,
    options.redirectUri,
  );
  try {
    const tokens = await client.validateAuthorizationCode(
      manifest.oauth.token_url,
      options.code,
      options.codeVerifier,
    );
    const refresh = manifest.oauth.refresh ? safely(() => tokens.refreshToken()) : undefined;
    const expires = safely(() => tokens.accessTokenExpiresAt());
    const scopes = safely(() => tokens.scopes()) ?? [];
    return {
      accessToken: tokens.accessToken(),
      ...(refresh ? { refreshToken: refresh } : {}),
      ...(expires ? { expiresAt: expires } : {}),
      scopes,
    };
  } catch (error) {
    throw new OAuthError(
      `${manifest.name} refused the code: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Arctic throws rather than returning undefined for fields a provider left out. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The same authorization-code flow, against endpoints discovered rather than written down (spec
 * §3.5 "MCP OAuth discovery … → PKCE"; task 2.14). `resource` is RFC 8707: it says which MCP server
 * the token is for, so a token minted for one resource is not usable at another.
 */
export function startAuthorizationAt(options: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[] | undefined;
  resource?: string | undefined;
}): OAuthStart {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const client = new OAuth2Client(options.clientId, null, options.redirectUri);
  const url = client.createAuthorizationURLWithPKCE(
    options.authorizeUrl,
    state,
    CodeChallengeMethod.S256,
    codeVerifier,
    [...(options.scopes ?? [])],
  );
  if (options.resource) url.searchParams.set("resource", options.resource);
  return { url: url.toString(), state, codeVerifier };
}

/**
 * The token request, written out rather than driven by a client library: the MCP lane needs
 * `resource` on it, and a server that registered us on the spot may or may not have given us a
 * secret. Nothing here is logged — the request and the answer are both secrets.
 */
export async function exchangeCodeAt(options: {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | null | undefined;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  resource?: string | undefined;
  fetcher?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
  });
  if (options.resource) form.set("resource", options.resource);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (options.clientSecret) {
    headers.authorization = `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`;
  }
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(options.tokenUrl, {
      method: "POST",
      headers,
      body: form.toString(),
    });
  } catch (error) {
    throw new OAuthError(
      `could not reach ${options.tokenUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new OAuthError(`the token endpoint answered ${response.status}`, response.status);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const access = typeof body?.access_token === "string" ? body.access_token : "";
  if (!access) throw new OAuthError("the token endpoint answered without an access token");
  const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : undefined;
  const scope = typeof body?.scope === "string" ? body.scope : "";
  return {
    accessToken: access,
    ...(typeof body?.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000) } : {}),
    scopes: scope.split(/[\s,]+/).filter(Boolean),
  };
}

/**
 * A new access token from a refresh token (spec §3.5 "refresh jobs on the Postgres queue"; task
 * 3.11). The same endpoint and the same client as the exchange that issued it — a provider that
 * rotates the refresh token hands back a new one, and a provider that does not says nothing, so the
 * caller keeps the one it had.
 */
export async function refreshTokens(options: {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | null | undefined;
  refreshToken: string;
  scopes?: readonly string[] | undefined;
  fetcher?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });
  if (options.scopes?.length) form.set("scope", options.scopes.join(" "));
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (options.clientSecret) {
    headers.authorization = `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`;
  }
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(options.tokenUrl, {
      method: "POST",
      headers,
      body: form.toString(),
    });
  } catch (error) {
    throw new OAuthError(
      `could not reach ${options.tokenUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new OAuthError(`the token endpoint answered ${response.status}`, response.status);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const access = typeof body?.access_token === "string" ? body.access_token : "";
  if (!access) throw new OAuthError("the token endpoint answered without an access token");
  const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : undefined;
  const scope = typeof body?.scope === "string" ? body.scope : "";
  return {
    accessToken: access,
    // Kept, not dropped: a provider that does not rotate sends no refresh_token back.
    refreshToken:
      typeof body?.refresh_token === "string" ? body.refresh_token : options.refreshToken,
    ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000) } : {}),
    scopes: scope.split(/[\s,]+/).filter(Boolean),
  };
}
