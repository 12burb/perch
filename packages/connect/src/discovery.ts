/**
 * Finding out how to authorize against an MCP server (spec §3.5 "MCP OAuth discovery via RFC 9728 →
 * RFC 8414/OIDC metadata → PKCE"; task 2.14).
 *
 * Three questions, asked in order. Which authorization server guards this resource (RFC 9728, or
 * the `WWW-Authenticate` header of its own 401)? Where are that server's endpoints (RFC 8414, or
 * OpenID Connect discovery)? And who are we, as a client — an app somebody registered, this
 * instance's own metadata document (CIMD), or a client the server hands out on the spot (RFC 7591)?
 *
 * Pure HTTP and JSON: nothing here is stored, and nothing here is a secret.
 */
import { z } from "zod";

/** The same narrow shape the rest of this package uses, so a test can stand in for the network. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

const resourceSchema = z
  .object({
    resource: z.string().optional(),
    authorization_servers: z.array(z.string()).default([]),
    scopes_supported: z.array(z.string()).optional(),
  })
  .loose();

export type ProtectedResource = z.infer<typeof resourceSchema>;

const serverSchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    registration_endpoint: z.string().optional(),
    scopes_supported: z.array(z.string()).optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    grant_types_supported: z.array(z.string()).optional(),
    /** The MCP auth spec's signal that a client_id may be a metadata document's URL (CIMD). */
    client_id_metadata_document_supported: z.boolean().optional(),
  })
  .loose();

export type AuthorizationServer = z.infer<typeof serverSchema>;

const registrationSchema = z
  .object({
    client_id: z.string(),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    registration_client_uri: z.string().optional(),
  })
  .loose();

export type RegisteredClient = z.infer<typeof registrationSchema>;

async function json(fetcher: FetchLike, url: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * RFC 9728 §3.1: the well-known document sits at the origin with the resource's path appended, and
 * older servers publish it at the bare path. Both are tried, nearest first.
 */
export function resourceMetadataUrls(mcpUrl: string): string[] {
  const url = new URL(mcpUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = [`${url.origin}/.well-known/oauth-protected-resource${path}`];
  if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** What a 401 says about where its metadata is (RFC 9728 §5.1), when it says anything. */
export function resourceMetadataFromChallenge(header: string | null): string | null {
  if (!header) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Which authorization server guards this MCP server. The published document first; failing that,
 * the server's own 401, which is what an implementation that predates RFC 9728 gives you.
 */
export async function protectedResource(
  mcpUrl: string,
  fetcher: FetchLike = fetch,
): Promise<ProtectedResource | null> {
  for (const url of resourceMetadataUrls(mcpUrl)) {
    const body = await json(fetcher, url);
    if (body) {
      const parsed = resourceSchema.safeParse(body);
      if (parsed.success && parsed.data.authorization_servers.length > 0) return parsed.data;
    }
  }
  // Ask the resource itself: an MCP server that wants a token says so, and may say where to get one.
  try {
    const answer = await fetcher(mcpUrl, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (answer.status === 401) {
      const pointed = resourceMetadataFromChallenge(answer.headers.get("www-authenticate"));
      if (pointed) {
        const body = await json(fetcher, pointed);
        const parsed = resourceSchema.safeParse(body);
        if (parsed.success && parsed.data.authorization_servers.length > 0) return parsed.data;
      }
    }
  } catch {
    // An unreachable server is not a discovery answer; the caller falls back to a pasted token.
  }
  return null;
}

/** RFC 8414 and OpenID Connect discovery, in that order (spec §3.5). */
export function serverMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/oauth-authorization-server`,
    `${url.origin}${path}/.well-known/openid-configuration`,
    `${url.origin}/.well-known/openid-configuration${path}`,
  ];
}

export async function authorizationServer(
  issuer: string,
  fetcher: FetchLike = fetch,
): Promise<AuthorizationServer | null> {
  for (const url of serverMetadataUrls(issuer)) {
    const body = await json(fetcher, url);
    if (!body) continue;
    const parsed = serverSchema.safeParse(body);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * RFC 7591: ask the server for a client of our own. The answer may carry a secret, which the caller
 * seals; a server that issues none is a public client, which is what PKCE is for.
 */
export async function registerClient(
  registrationEndpoint: string,
  metadata: Record<string, unknown>,
  fetcher: FetchLike = fetch,
): Promise<RegisteredClient> {
  let response: Response;
  try {
    response = await fetcher(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(metadata),
    });
  } catch (error) {
    throw new DiscoveryError(
      `could not reach ${registrationEndpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new DiscoveryError(`${registrationEndpoint} refused the registration`, response.status);
  }
  const parsed = registrationSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new DiscoveryError("the registration answer was not a client");
  return parsed.data;
}

/** How this instance came by the client id it is about to use (spec §3.5's lanes, in order). */
export const REGISTRATION_LANES = ["pre_registered", "cimd", "dcr"] as const;
export type RegistrationLane = (typeof REGISTRATION_LANES)[number];

export type ClientChoice = {
  lane: RegistrationLane;
  clientId: string;
  clientSecret?: string | undefined;
};

export type ChooseClientOptions = {
  server: AuthorizationServer;
  /** An app this workspace registered with the provider, when it has one. */
  preRegistered?: { clientId: string; clientSecret?: string | null } | undefined;
  /** This instance's client metadata document URL, which is also the client_id it declares. */
  cimdUrl: string;
  /** What to send when the lane is registration: RFC 7591's metadata for this instance. */
  registration: Record<string, unknown>;
  fetcher?: FetchLike | undefined;
};

/**
 * Who we are, by the first lane that works: an app somebody registered here, then this instance's
 * own metadata document when the server takes one, then a client registered on the spot. A server
 * that offers none of the three leaves the token paste lane, which every provider always has.
 */
export async function chooseClient(options: ChooseClientOptions): Promise<ClientChoice> {
  if (options.preRegistered?.clientId) {
    return {
      lane: "pre_registered",
      clientId: options.preRegistered.clientId,
      ...(options.preRegistered.clientSecret
        ? { clientSecret: options.preRegistered.clientSecret }
        : {}),
    };
  }
  if (options.server.client_id_metadata_document_supported === true) {
    return { lane: "cimd", clientId: options.cimdUrl };
  }
  if (options.server.registration_endpoint) {
    const registered = await registerClient(
      options.server.registration_endpoint,
      options.registration,
      options.fetcher ?? fetch,
    );
    return {
      lane: "dcr",
      clientId: registered.client_id,
      ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
    };
  }
  throw new DiscoveryError(
    "this server registers no clients of its own; register an app or paste a token",
  );
}
