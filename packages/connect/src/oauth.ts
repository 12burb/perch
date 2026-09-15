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
