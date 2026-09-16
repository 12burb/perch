/**
 * The MCP gateway (spec §3.5, §7.5; task 1.17): Perch exposes each connection as a Streamable HTTP
 * MCP server at `/mcp/{connectionId}`, and stands in the middle so an agent never holds a
 * credential.
 *
 * The invariant (AGENTS.md §1.6): "downstream consumers never see raw tokens". A session is given a
 * URL and a token of Perch's own minting — good for that session, that workspace, and nothing else.
 * The connection's real token is attached here, on the upstream call, and goes no further.
 */
import type { Bus } from "@perch/bus";
import {
  allowed,
  argsHash,
  listUpstreamTools,
  McpError,
  mcpUrlOf,
  openUpstream,
  permits,
  type UpstreamTool,
} from "@perch/connect";
import type { Connection, Db } from "@perch/db";
import type { SessionMcpServer } from "@perch/events";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { listGrants, upsertGrant } from "../repos/connections.ts";
import type { ConnectionsService } from "./connections.ts";

const encoder = new TextEncoder();

/** What a gateway token says: who is calling, for which workspace, until when. */
export type ToolTokenClaims = {
  ws: string;
  user: string;
  /** The session this was minted for, so a leaked token dies with it. */
  session: string;
  exp: number;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** How long a session's gateway token is good for. Long enough for a turn, short enough to matter. */
export const TOOL_TOKEN_MS = 12 * 60 * 60_000;

export async function mintToolToken(secret: string, claims: ToolTokenClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyToolToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<ToolTokenClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = fromBase64Url(token.slice(dot + 1));
  const payloadBytes = fromBase64Url(payload);
  if (!signature || !payloadBytes) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    signature,
    encoder.encode(payload),
  );
  if (!valid) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as ToolTokenClaims;
    if (typeof claims.exp !== "number" || claims.exp < now) return null;
    if (!claims.ws || !claims.user || !claims.session) return null;
    return claims;
  } catch {
    return null;
  }
}

export type McpDeps = {
  db: Db;
  bus: Bus;
  log: Logger;
  connections: ConnectionsService;
  /** Signs the tokens a session carries to the gateway. */
  secret: string;
  publicUrl: string;
};

export class McpGateway {
  constructor(private readonly deps: McpDeps) {}

  /**
   * The MCP servers to put in front of a session (spec §7.5 "downstream consumers via injected MCP
   * config"). One per connection whose provider publishes an MCP URL and whose grant names this
   * session. The token is Perch's, not the provider's.
   */
  async serversFor(input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
  }): Promise<SessionMcpServer[]> {
    const rows = await this.deps.connections.connections(input.workspaceId, input.userId);
    const servers: SessionMcpServer[] = [];
    for (const row of rows) {
      const manifest = this.deps.connections.providers().find((m) => m.id === row.provider);
      if (!manifest || !mcpUrlOf(manifest, row.metadata.mcpUrl)) continue;
      const grants = await listGrants(this.deps.db, row.id);
      const granted = grants.find(
        (grant) => grant.subjectType === "session" && grant.subjectId === input.sessionId,
      );
      if (!granted) continue;
      servers.push({
        name: row.provider,
        url: `${this.deps.publicUrl.replace(/\/+$/, "")}/mcp/${row.id}`,
        token: await mintToolToken(this.deps.secret, {
          ws: input.workspaceId,
          user: input.userId,
          session: input.sessionId,
          exp: Date.now() + TOOL_TOKEN_MS,
        }),
      });
    }
    return servers;
  }

  /**
   * A new session is granted the connections its own owner may already use (task 1.17, ADR-0083):
   * a personal connection is the person acting through an agent, which is on-behalf-of by
   * definition. A workspace connection is not auto-granted — spec §3.5 wants those granted
   * explicitly — so it stays invisible to a session until the grants UI of task 2.14 says
   * otherwise. Nothing here narrows the tool list; a grant's `allowed_tools` does that, and the
   * gateway honours it the moment one is written.
   */
  async grantSession(input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
  }): Promise<number> {
    const rows = await this.deps.connections.connections(input.workspaceId, input.userId);
    let granted = 0;
    for (const row of rows) {
      if (row.ownerType !== "user" || row.ownerId !== input.userId) continue;
      if (row.status !== "active") continue;
      const manifest = this.deps.connections.providers().find((m) => m.id === row.provider);
      if (!manifest || !mcpUrlOf(manifest, row.metadata.mcpUrl)) continue;
      await upsertGrant(this.deps.db, {
        connectionId: row.id,
        subjectType: "session",
        subjectId: input.sessionId,
        allowedTools: null,
        requiresPermission: null,
        channels: null,
        obo: true,
        grantedBy: input.userId,
      });
      granted += 1;
    }
    return granted;
  }

  /** The allow-list this caller is held to, or null when the grant did not narrow anything. */
  async allowListFor(connection: Connection, sessionId: string): Promise<string[] | null> {
    const grants = await listGrants(this.deps.db, connection.id);
    const granted = grants.find(
      (grant) => grant.subjectType === "session" && grant.subjectId === sessionId,
    );
    if (!granted) throw PerchError.forbidden("this session may not use that connection");
    return granted.allowedTools ?? null;
  }

  /** What the caller may see: the upstream's tools, filtered by the grant (spec §7.5). */
  async tools(connection: Connection, allowList: string[] | null): Promise<UpstreamTool[]> {
    const client = await this.upstream(connection);
    try {
      return allowed(await listUpstreamTools(client), allowList);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * One tool call, audited whatever happens (spec §7.5 "every call audited"). A tool the grant does
   * not name is refused before the upstream is touched, and the refusal is audited too.
   */
  async call(input: {
    connection: Connection;
    allowList: string[] | null;
    tool: string;
    args: Record<string, unknown>;
    by: ActorContext;
    callerId: string;
  }): Promise<unknown> {
    const hash = await argsHash(input.args);
    const audit = (outcome: "ok" | "error" | "denied") =>
      this.deps.bus.publish(
        "tools.called",
        {
          workspaceId: input.connection.workspaceId,
          connectionId: input.connection.id,
          tool: input.tool,
          // Who actually called it. A bot's tool call audited as a person's is a lie in the one
          // record that is supposed to settle arguments (task 3.3).
          callerType: input.by.actor.type,
          callerId: input.callerId,
          argsHash: hash,
          outcome,
        },
        { ...input.by, topics: [`ws:${input.connection.workspaceId}`] },
      );
    if (!permits(input.allowList, input.tool)) {
      await audit("denied");
      throw PerchError.forbidden(`this caller may not call ${input.tool}`, {
        rule: "connection.grant",
        tool: input.tool,
      });
    }
    const client = await this.upstream(input.connection);
    try {
      const result = await client.callTool({ name: input.tool, arguments: input.args });
      await audit("ok");
      return result;
    } catch (error) {
      await audit("error");
      throw this.upstreamError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** The upstream server, with the connection's own token on it and nothing of the caller's. */
  private async upstream(connection: Connection) {
    const manifest = this.deps.connections.manifest(connection.provider);
    const url = mcpUrlOf(manifest, connection.metadata.mcpUrl);
    if (!url) throw PerchError.validation(`${manifest.name} publishes no MCP server`);
    const token = await this.deps.connections.tokenFor(connection);
    return openUpstream({ url, token });
  }

  private upstreamError(error: unknown): PerchError {
    if (error instanceof PerchError) return error;
    const message =
      error instanceof McpError || error instanceof Error ? error.message : String(error);
    return new PerchError("upstream_failed", message, undefined, 502);
  }
}
