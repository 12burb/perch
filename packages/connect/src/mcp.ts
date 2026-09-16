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

/**
 * The two ends of a text stream, as much of one as a transport needs. `RunnerStream` is one
 * (spec §7.6); this package does not know that, and does not need to.
 */
export type LineStream = {
  send(data: string): void;
  onMessage(handler: (data: string) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
  readonly closed: boolean;
};

/**
 * MCP over a runner's data stream (spec §7.6 `mcp.spawn`; task 3.24).
 *
 * MCP's stdio transport is newline-delimited JSON and a runner stream carries text frames, so a
 * server the runner spawned speaks the same protocol as one behind a URL — this is the adapter
 * between the two, and the gateway above it cannot tell the difference.
 */
class StreamTransport {
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private rest = "";
  private stop: (() => void) | null = null;

  constructor(private readonly stream: LineStream) {}

  async start(): Promise<void> {
    const unsubscribe = this.stream.onMessage((data) => this.take(data));
    const unclose = this.stream.onClose(() => this.onclose?.());
    this.stop = () => {
      unsubscribe();
      unclose();
    };
  }

  async send(message: unknown): Promise<void> {
    if (this.stream.closed) throw new McpError("the server's stream has closed");
    this.stream.send(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.stop?.();
    this.stop = null;
    this.stream.close();
  }

  /**
   * Frames are not lines: one frame can carry several, or half of one. A frame that ends without
   * a newline is kept until the rest of it arrives — except that a whole message with nothing
   * after it is a whole message, which is what a sender that frames per message produces.
   */
  private take(data: string): void {
    this.rest += data;
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    if (lines.length === 0 && whole(this.rest)) {
      lines.push(this.rest);
      this.rest = "";
    }
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      try {
        this.onmessage?.(JSON.parse(text));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

/** Whether a buffer is a complete JSON message rather than the first half of one. */
function whole(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * A client on a server the runner is hosting, already initialised. The caller closes it, which
 * closes the stream, which is what stops the process.
 */
export async function openLocal(stream: LineStream): Promise<Client> {
  const client = new Client({ name: "perch", version: "1" }, { capabilities: {} });
  try {
    // The SDK types its transports nominally; this is one structurally, which is the whole of
    // what it uses.
    await client.connect(new StreamTransport(stream) as never);
  } catch (error) {
    throw new McpError(
      `could not reach the runner's MCP server: ${error instanceof Error ? error.message : String(error)}`,
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
