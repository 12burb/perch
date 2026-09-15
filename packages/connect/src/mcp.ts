/**
 * The MCP gateway (spec §3.5, §7.5; task 1.17): Perch stands between an agent and a provider's MCP
 * server so the agent never holds the credential.
 *
 * The shape is a proxy that understands what it is proxying. It has to: §7.5 says tools are
 * filtered by a grant's allow-list and every call is audited, and neither is possible without
 * reading the traffic. So the gateway speaks MCP on both sides — a client upstream, carrying the
 * connection's delegated token, and a server downstream, carrying nothing at all.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type UpstreamTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export class McpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export type UpstreamOptions = {
  url: string;
  /** The connection's token. It goes in this header and is never seen downstream. */
  token?: string | null;
  /** Extra headers a provider's MCP server asks for. */
  headers?: Record<string, string>;
  timeoutMs?: number;
};

/**
 * A client on the upstream server, already initialised. The caller closes it: one connection per
 * request keeps a slow provider from holding a pool hostage, which a skeleton can afford.
 */
export async function openUpstream(options: UpstreamOptions): Promise<Client> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const client = new Client({ name: "perch", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers },
  });
  try {
    await client.connect(transport);
  } catch (error) {
    // Never repeat the request: its headers carry the token.
    throw new McpError(
      `could not reach ${options.url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return client;
}

/** What the upstream says it can do, as plain data. */
export async function listUpstreamTools(client: Client): Promise<UpstreamTool[]> {
  const answer = await client.listTools();
  return answer.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
  }));
}

/**
 * The tools a caller may actually see. `null` means the grant did not narrow anything, which is
 * every tool; a list narrows it, and a name that is not on it does not exist as far as the caller
 * is concerned — a tool nobody may call should not be advertised either (spec §7.5).
 */
export function allowed(
  tools: UpstreamTool[],
  allowList: readonly string[] | null,
): UpstreamTool[] {
  if (!allowList) return tools;
  const permitted = new Set(allowList);
  return tools.filter((tool) => permitted.has(tool.name));
}

/** Whether a call is one this caller may make at all. */
export function permits(allowList: readonly string[] | null, tool: string): boolean {
  return !allowList || allowList.includes(tool);
}

/**
 * A stable fingerprint of a call's arguments for the audit log (spec §7.5 "args hash"): enough to
 * tell two calls apart and to spot a repeat, and useless for recovering what was in them.
 */
export async function argsHash(args: unknown): Promise<string> {
  const canonical = JSON.stringify(sorted(args));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Key order should not change a hash, so the same call always fingerprints the same way. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, inner]) => [key, sorted(inner)]));
  }
  return value;
}
