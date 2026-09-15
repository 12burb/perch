/**
 * The Client ID Metadata Document (spec §3.5; task 1.16). Since 2026-07 the MCP auth spec's primary
 * registration path is CIMD: an instance publishes its client metadata at a URL and uses that URL
 * as its `client_id`, so a provider learns who is asking without Perch registering an app first.
 *
 * Nothing here is a secret: it is the public description of this instance as an OAuth client, and
 * every field comes from PERCH_PUBLIC_URL so a self-hosted instance is correct by construction.
 */

export type ClientMetadata = {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
  software_id: string;
  software_version: string;
};

/** Where the document lives; this URL is also the client_id it declares. */
export const CIMD_PATH = "/.well-known/oauth-client-metadata.json";

/** Where a provider sends the person back after they approve (spec §7.1). */
export function callbackUrl(publicUrl: string, provider: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/connect/callback/${encodeURIComponent(provider)}`;
}

/** Where a provider posts events for a connection (spec §3.5 `/hooks/:provider/:id`). */
export function webhookUrl(publicUrl: string, provider: string, id: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/hooks/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
}

/**
 * This instance as an OAuth client. Public clients with PKCE: Perch is self-hosted, so there is no
 * shared secret a provider could have issued it, and none is claimed.
 */
export function clientMetadata(options: {
  publicUrl: string;
  version: string;
  /** Every provider Perch may send someone to, so one document covers them all. */
  providers: readonly string[];
}): ClientMetadata {
  const base = options.publicUrl.replace(/\/+$/, "");
  return {
    client_id: `${base}${CIMD_PATH}`,
    client_name: "Perch",
    client_uri: base,
    redirect_uris: options.providers.map((provider) => callbackUrl(base, provider)),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    software_id: "perch",
    software_version: options.version,
  };
}
