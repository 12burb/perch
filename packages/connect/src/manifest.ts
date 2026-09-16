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
export const AUTH_KINDS = ["token", "oauth2", "github_app", "mcp_oauth"] as const;
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

/**
 * What the database panel needs from a provider that has one (spec §5.5; task 2.15). The panel is
 * the MCP gateway with these tool names, so a provider whose MCP server can list tables and run a
 * query needs a manifest and no code.
 */
const dbSchema = z
  .object({
    /** The tool that lists tables, and the argument it takes the schemas in. */
    tables_tool: z.string().min(1),
    schemas_arg: z.string().min(1).default("schemas"),
    /** The schemas to ask about when nobody says otherwise. */
    schemas: z.array(z.string()).default(["public"]),
    /** The tool that runs one statement, and the argument it takes it in. */
    query_tool: z.string().min(1),
    query_arg: z.string().min(1).default("query"),
  })
  .strict();

export type DbManifest = z.infer<typeof dbSchema>;

/**
 * How one provider signs what it sends (spec §3.5 "inbound webhooks at /hooks/:provider/:id with
 * signature verification"; task 3.4). Three shapes cover every provider Perch ships:
 *
 * - GitHub: `X-Hub-Signature-256: sha256=<hex>` over the raw body;
 * - Vercel: `x-vercel-signature: <hex>` over the raw body, no prefix;
 * - Clerk (Svix): `svix-signature: v1,<base64>` over `<id>.<timestamp>.<body>`, with the id and
 *   the timestamp in their own headers and a tolerance either side of now.
 *
 * Writing them down here rather than in code is what keeps a connector a file (ADR-0119).
 */
const webhookSchema = z
  .object({
    /** The header carrying the signature. */
    header: z.string().min(1).default("x-hub-signature-256"),
    /** What the signature is prefixed with, when it is. `sha256=` for GitHub, `v1,` for Svix. */
    prefix: z.string().default(""),
    encoding: z.enum(["hex", "base64"]).default("hex"),
    /**
     * What is signed. `{body}` is the raw body; `{id}` and `{timestamp}` are the headers below.
     * A provider that signs the body alone leaves this as it is.
     */
    signed: z.string().default("{body}"),
    /** The header carrying the delivery's own id, which is how a replay is spotted. */
    id_header: z.string().default("x-github-delivery"),
    /** The header naming what happened, which is what a card is titled with. */
    event_header: z.string().default("x-github-event"),
    /** The header carrying the time it was signed, when the scheme signs one. */
    timestamp_header: z.string().optional(),
    /** How far out that timestamp may be, in seconds. */
    tolerance_s: z.number().int().min(1).max(3_600).default(300),
  })
  .strict()
  .prefault({});

export type WebhookScheme = z.infer<typeof webhookSchema>;

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
    /** How to browse this provider's database, when it has one (task 2.15). */
    db: dbSchema.optional(),
    /** How inbound webhooks are signed, when this provider sends them (task 3.4). */
    webhook_signature: z.enum(["hmac_sha256", "none"]).default("none"),
    /** Where the signature and the delivery's own identity are, in this provider's headers. */
    webhook: webhookSchema,
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
  if (data.db && !data.mcp_url) {
    throw new ManifestError("a manifest with a db block needs the MCP server it browses through", [
      "mcp_url: required when db is set",
    ]);
  }
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
  // The order the Connections card offers them in: the most specific lane a provider has first,
  // and the paste lane last, because it always works and is never the best answer (spec §3.5).
  const order: AuthKind[] = ["github_app", "mcp_oauth", "oauth2", "token"];
  return order.filter((lane) => manifest.auth.includes(lane));
}

/** Where a call to this connection goes: the connection's own host, else the manifest's. */
export function apiBaseOf(manifest: Manifest, override?: string | null): string {
  return (override?.trim() || manifest.api_base).replace(/\/+$/, "");
}

/**
 * The MCP server this connection is proxied to (task 1.17), or null when there is none. A
 * self-hosted host runs its own, so a connection may override the manifest's — the same escape
 * hatch `api_base` is, and needed for the same reason: an enterprise install is not the public one.
 */
export function mcpUrlOf(manifest: Manifest, override?: string | null): string | null {
  return override?.trim() || manifest.mcp_url || null;
}
