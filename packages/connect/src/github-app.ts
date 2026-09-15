/**
 * The GitHub App lane (spec §3.5: "GitHub remote MCP has no DCR → GitHub App (installation tokens,
 * webhooks, check runs) or fine-grained PAT"; task 1.16).
 *
 * An app authenticates as itself with a short-lived RS256 JWT signed by its private key, then
 * exchanges that for an installation token which is what actually touches a repository. The
 * installation token lives about an hour and is minted on demand rather than stored, so the only
 * thing Perch keeps is the private key — in the vault, decrypted here and nowhere else.
 *
 * The signing is done with WebCrypto rather than a JWT library: Bun has RS256 built in, and a
 * dependency for sixty lines is a dependency to keep current (ADR-0082).
 */

/** Just enough of fetch to make a request; the global is assignable, and so is a test's stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubAppError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

const encoder = new TextEncoder();

/** WebCrypto takes an ArrayBuffer; a Uint8Array's own buffer may be longer than its view. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** base64url without padding, as JWS wants it. */
function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The DER bytes inside a PEM block, whatever line endings it arrived with. */
function derOf(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new GitHubAppError("the app's private key is empty");
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new GitHubAppError("the app's private key is not valid PEM");
  }
}

/**
 * GitHub issues keys in PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports PKCS#8. Wrapping the
 * PKCS#1 body in the PKCS#8 header is a fixed prefix, so no parser is needed.
 */
function toPkcs8(der: Uint8Array, pem: string): Uint8Array {
  if (!/BEGIN RSA PRIVATE KEY/.test(pem)) return der;
  // SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { <der> } }
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...length(der.length), ...der];
  const inner = [...version, ...algorithm, ...octet];
  return new Uint8Array([0x30, ...length(inner.length), ...inner]);
}

/** A DER length: short form under 128, else the byte count then the bytes. */
function length(value: number): number[] {
  if (value < 0x80) return [value];
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * The app's own JWT: `iss` is the app id, and GitHub rejects anything older than 10 minutes or
 * dated in the future, so `iat` is backdated a minute against clock skew and `exp` is 9 minutes on.
 */
export async function appJwt(options: {
  appId: string;
  privateKeyPem: string;
  now?: number;
}): Promise<string> {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(
    encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: options.appId })),
  );
  const pem = options.privateKeyPem.trim();
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      bufferOf(toPkcs8(derOf(pem), pem)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof GitHubAppError) throw error;
    throw new GitHubAppError("the app's private key could not be read as an RSA key");
  }
  const signed = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    bufferOf(encoder.encode(signed)),
  );
  return `${signed}.${b64url(signature)}`;
}

export type InstallationToken = { token: string; expiresAt: Date; repositorySelection?: string };

/**
 * Mints the installation token a repository call actually uses. Never logged, never stored: it is
 * handed to the one call that needs it and forgotten (AGENTS.md §1.6).
 */
export async function installationToken(options: {
  appId: string;
  privateKeyPem: string;
  installationId: string;
  apiBase?: string;
  fetch?: FetchLike;
  now?: number;
}): Promise<InstallationToken> {
  const base = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const jwt = await appJwt({
    appId: options.appId,
    privateKeyPem: options.privateKeyPem,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const call: FetchLike = options.fetch ?? fetch;
  const url = `${base}/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`;
  let response: Response;
  try {
    response = await call(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // The request carries the app JWT, so the reason is repeated and the request never is.
    throw new GitHubAppError(
      `could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new GitHubAppError(
      `${base} answered ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    token?: unknown;
    expires_at?: unknown;
    repository_selection?: unknown;
  } | null;
  if (!body || typeof body.token !== "string") {
    throw new GitHubAppError("GitHub did not answer with an installation token");
  }
  const expiresAt =
    typeof body.expires_at === "string"
      ? new Date(body.expires_at)
      : new Date(Date.now() + 3_600_000);
  return {
    token: body.token,
    expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(Date.now() + 3_600_000) : expiresAt,
    ...(typeof body.repository_selection === "string"
      ? { repositorySelection: body.repository_selection }
      : {}),
  };
}

/** Where a person installs the app, and where they land afterwards (the wizard's two links). */
export function installUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}
