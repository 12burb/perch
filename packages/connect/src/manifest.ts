/**
 * Connector manifests (spec §3.5, §5.5; task 1.16). A manifest is what Perch needs to reach one
 * service: how it authenticates, where its API lives, which scopes to ask for, and — later — its
 * MCP URL and webhook signature scheme. Everything Perch knows about a provider comes from here,
 * so adding one is a YAML file rather than a release.
 */
import { parse } from "yaml";
import { z } from "zod";

/**
 * The lanes of §3.5, narrowed to what a manifest can describe. `token` is the paste lane and is
 * always available whatever else a manifest says; `oauth2` drives an authorization-code flow;
 * `github_app` mints an installation token per use.
 */
export const AUTH_KINDS = ["token", "oauth2", "github_app"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

const oauthSchema = z
  .object({
    authorize_url: z.url(),
    token_url: z.url(),
    /** What Perch asks for when nothing else says otherwise. */
    scopes: z.array(z.string()).default([]),
    /** How scopes are joined in the request; GitHub wants a comma, most want a space. */
    scope_separator: z.string().default(" "),
    /** Whether the provider issues refresh tokens, so the refresh job knows to run. */
    refresh: z.boolean().default(false),
  })
  .strict();

const manifestSchema = z
  .object({
    /** The id used in routes, connections.provider, and the connectors index. */
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "an id is lowercase letters, digits, and dashes"),
    name: z.string().min(1).max(120),
    /** One line for the Connections card. */
    summary: z.string().max(300).optional(),
    docs_url: z.url().optional(),
    /** Every lane this provider supports, best first; `token` is appended if it is missing. */
    auth: z.array(z.enum(AUTH_KINDS)).min(1),
    /** Where the REST API lives; a connection may override it for a self-hosted host. */
    api_base: z.url(),
    /** What a pasted token should look like, so an obvious paste error is caught before a call. */
    token_prefix: z.array(z.string()).default([]),
    /** The call that proves a connection works, relative to api_base. */
    test_path: z.string().default("/"),
    /** Where the account name is in the test call's answer, so a card can show who it speaks as. */
    account_field: z.string().optional(),
    oauth: oauthSchema.optional(),
    /** The Streamable HTTP MCP server this provider exposes, when it has one (task 1.17). */
    mcp_url: z.url().optional(),
    /** How inbound webhooks are signed, when this provider sends them (task 2.x). */
    webhook_signature: z.enum(["hmac_sha256", "none"]).default("none"),
  })
  .strict();

export type Manifest = Omit<z.infer<typeof manifestSchema>, "auth"> & { auth: AuthKind[] };

export class ManifestError extends Error {
  constructor(
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

/** Reads one manifest.yaml. A manifest that does not parse is an error, never a partial provider. */
export function parseManifest(source: string): Manifest {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new ManifestError(`manifest is not YAML: ${(error as Error).message}`);
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ManifestError(`manifest is not valid: ${issues.join("; ")}`, issues);
  }
  const data = result.data;
  if (data.auth.includes("oauth2") && !data.oauth) {
    throw new ManifestError("a manifest with the oauth2 lane needs an oauth block", [
      "oauth: required when auth includes oauth2",
    ]);
  }
  // The paste lane is always available (§3.5), so a manifest that forgot it still has it.
  const auth: AuthKind[] = data.auth.includes("token") ? data.auth : [...data.auth, "token"];
  return { ...data, auth };
}

/** The lanes to try, in the order §3.5 gives them: the strongest identity first, paste last. */
export function lanesOf(manifest: Manifest): AuthKind[] {
  const order: AuthKind[] = ["github_app", "oauth2", "token"];
  return order.filter((lane) => manifest.auth.includes(lane));
}

/** Where a call to this connection goes: the connection's own host, else the manifest's. */
export function apiBaseOf(manifest: Manifest, override?: string | null): string {
  return (override?.trim() || manifest.api_base).replace(/\/+$/, "");
}
