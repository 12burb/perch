/**
 * Perch's own MCP server (spec §3.5, §7.5 "Perch's own MCP server at /mcp/perch"; task 3.12).
 *
 * Everywhere else in the gateway Perch is a proxy: `/mcp/{connectionId}` puts a provider's tools
 * in front of a caller with the provider's credential attached upstream. Here Perch is the
 * provider. An agent that lives outside — Hermes on somebody's laptop, a cron script, an IDE —
 * reads the chat, searches it, answers in it, and opens a coding session, all through MCP and an
 * api token.
 *
 * What it may do is the token's scopes, and nothing about that is new: §7.1's api tokens already
 * carry `chat:read`, `chat:write`, `sessions:open`, `work:write` and `tools:call`, which is
 * one-to-one with the tools §7.5 names. A tool a token has no scope for is not refused at the end
 * of an argument round-trip — it is not in `tools/list` at all, so an agent never plans around a
 * door it cannot open. Each tool then goes through the same service the REST handler for it goes
 * through, so a stranger's channel is as invisible here as it is there.
 */

import type { Bus } from "@perch/bus";
import type { ApiTokenScopes, Channel, DbHandle } from "@perch/db";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { getChannel, listChannelsFor } from "../repos/channels.ts";
import { findProject } from "../repos/projects.ts";
import { listWorkspacesForUser } from "../repos/workspaces.ts";
import type { ConnectionsService } from "./connections.ts";
import type { McpGateway } from "./mcp.ts";
import { post, textBlocks } from "./messages.ts";
import { search } from "./search.ts";
import type { SessionService } from "./sessions.ts";

/** An MCP tool as the SDK wants it handed over. */
export type PerchTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** The api-token scope that buys it (spec §7.1). */
  scope: (typeof SCOPES)[number];
};

const SCOPES = [
  "read",
  "write",
  "admin",
  "sessions:open",
  "chat:write",
  "chat:read",
  "work:write",
  "tools:call",
] as const;

/** Who is calling: the person whose api token it is, and what that token may do. */
export type PerchCaller = {
  userId: string;
  /** The workspace the token was made for, when it was made for one. */
  workspaceId: string | null;
  scopes: ApiTokenScopes;
};

const str = (description: string) => ({ type: "string", description });

/**
 * The seven tools §7.5 names, minus the two that have nothing to stand on yet: `work.create` and
 * `work.update` arrive with the work items they are about (task 3.13), which is why this is a list
 * rather than a switch — adding them there is an entry and a case.
 */
export const PERCH_TOOLS: PerchTool[] = [
  {
    name: "channels.list",
    description:
      "The channels you can see, across every workspace you are in. Start here: the ids the other tools take come from this.",
    scope: "chat:read",
    inputSchema: {
      type: "object",
      properties: { workspace: str("Only this workspace's channels, by id.") },
    },
  },
  {
    name: "messages.search",
    description: "Search the chat you can see. Returns the message, who wrote it, and where.",
    scope: "chat:read",
    inputSchema: {
      type: "object",
      properties: {
        query: str("What to look for."),
        workspace: str("Which workspace to search, by id. Needed if you are in more than one."),
        channel: str("Only this channel, by id."),
        limit: { type: "number", description: "At most this many, up to 50." },
      },
      required: ["query"],
    },
  },
  {
    name: "messages.post",
    description: "Say something in a channel, as the person whose token this is.",
    scope: "chat:write",
    inputSchema: {
      type: "object",
      properties: {
        channel: str("The channel id, from channels.list."),
        text: str("What to say."),
        thread: str("A message id to reply under, to keep it in that thread."),
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "sessions.open",
    description:
      "Open a coding session on a project: a real agent in a real checkout. Returns the session's id and where a person can watch it.",
    scope: "sessions:open",
    inputSchema: {
      type: "object",
      properties: {
        project: str("The project id."),
        prompt: str("The first turn. Without one the session opens idle."),
        engine: str("Which engine to run, if not the project's default."),
      },
      required: ["project"],
    },
  },
  {
    name: "connections.call",
    description:
      "Call a tool on one of this workspace's connections. Perch attaches the credential; you never see it.",
    scope: "tools:call",
    inputSchema: {
      type: "object",
      properties: {
        connection: str("The connection id."),
        tool: str("The tool's name on that connection."),
        args: { type: "object", description: "The tool's own arguments." },
      },
      required: ["connection", "tool"],
    },
  },
];

export type PerchMcpDeps = {
  db: DbHandle;
  log: Logger;
  sessions: SessionService;
  connections: ConnectionsService;
  mcp: McpGateway;
  bus: Bus;
  env: { publicUrl: string };
};

/** A tool's answer: MCP carries text, and everything here carries JSON in it. */
function json(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export class PerchMcpService {
  constructor(private readonly deps: PerchMcpDeps) {}

  /** The tools this caller may use. Anything else is not theirs to know about. */
  tools(caller: PerchCaller): PerchTool[] {
    return PERCH_TOOLS.filter((tool) => allowed(caller, tool.scope));
  }

  async call(
    caller: PerchCaller,
    name: string,
    args: Record<string, unknown>,
    by: ActorContext,
  ): Promise<{ content: { type: "text"; text: string }[] }> {
    const tool = PERCH_TOOLS.find((one) => one.name === name);
    if (!tool) throw PerchError.validation(`there is no tool called ${name}`);
    if (!allowed(caller, tool.scope)) {
      throw PerchError.forbidden(`${name} needs the ${tool.scope} scope, and this token has none`, {
        tool: name,
        scope: tool.scope,
      });
    }
    switch (name) {
      case "channels.list":
        return json(await this.channels(caller, text(args.workspace)));
      case "messages.search":
        return json(await this.search(caller, args));
      case "messages.post":
        return json(await this.post(caller, args, by));
      case "sessions.open":
        return json(await this.openSession(caller, args, by));
      case "connections.call":
        return json(await this.callConnection(caller, args, by));
      default:
        throw PerchError.validation(`there is no tool called ${name}`);
    }
  }

  /**
   * Every workspace this token may act in. A token made for one workspace is that one; a token
   * made for none is every workspace the person is a member of, which is what makes
   * `channels.list` a sensible first call for an agent that was told nothing.
   */
  private async workspaces(caller: PerchCaller): Promise<string[]> {
    if (caller.workspaceId) return [caller.workspaceId];
    const mine = await listWorkspacesForUser(this.deps.db.db, caller.userId);
    return mine.map((one) => one.workspace.id);
  }

  /** The one workspace a call is about, when a call has to be about one. */
  private async oneWorkspace(caller: PerchCaller, asked: string | undefined): Promise<string> {
    const mine = await this.workspaces(caller);
    if (asked) {
      if (!mine.includes(asked)) throw PerchError.notFound("workspace");
      return asked;
    }
    const only = mine[0];
    if (mine.length !== 1 || !only) {
      throw PerchError.validation("say which workspace: this token can act in more than one", {
        workspaces: mine,
      });
    }
    return only;
  }

  private async channels(caller: PerchCaller, workspace: string | undefined) {
    const ids = workspace
      ? [await this.oneWorkspace(caller, workspace)]
      : await this.workspaces(caller);
    const rows = [];
    for (const id of ids) {
      for (const channel of await listChannelsFor(this.deps.db.db, id, caller.userId)) {
        rows.push({
          id: channel.id,
          workspace_id: id,
          name: channel.name,
          type: channel.type,
          topic: channel.topic,
          unread: channel.unread,
        });
      }
    }
    return { channels: rows };
  }

  private async search(caller: PerchCaller, args: Record<string, unknown>) {
    const q = text(args.query);
    if (!q) throw PerchError.validation("say what to search for");
    const workspaceId = await this.oneWorkspace(caller, text(args.workspace));
    const limit = typeof args.limit === "number" ? Math.min(Math.trunc(args.limit), 50) : 20;
    const results = await search(
      { db: this.deps.db, bus: this.deps.bus },
      {
        workspaceId,
        userId: caller.userId,
        q,
        type: "messages",
        limit,
        ...(text(args.channel) ? { channelId: text(args.channel) } : {}),
      },
    );
    return {
      messages: results.messages.map((hit) => ({
        id: hit.message.id,
        channel_id: hit.channelId,
        channel_name: hit.channelName,
        author_name: hit.authorName,
        text: plain(hit.message.blocks),
        created_at: hit.message.createdAt.toISOString(),
        url: this.link(workspaceId, hit.channelId, hit.message.id),
      })),
    };
  }

  private async post(caller: PerchCaller, args: Record<string, unknown>, by: ActorContext) {
    const channel = await this.channel(caller, text(args.channel));
    const body = text(args.text);
    if (!body) throw PerchError.validation("say something");
    const message = await post(
      { db: this.deps.db, bus: this.deps.bus },
      {
        channel,
        userId: caller.userId,
        blocks: textBlocks(body),
        by,
        ...(text(args.thread) ? { threadRootId: text(args.thread) } : {}),
      },
    );
    return {
      message_id: message.id,
      channel_id: message.channelId,
      thread_id: message.threadRootId,
      url: this.link(channel.workspaceId, channel.id, message.id),
    };
  }

  private async openSession(caller: PerchCaller, args: Record<string, unknown>, by: ActorContext) {
    const projectId = text(args.project);
    if (!projectId) throw PerchError.validation("say which project");
    const project = await this.project(caller, projectId);
    const session = await this.deps.sessions.create({
      project,
      userId: caller.userId,
      by,
      ...(text(args.engine) ? { engine: text(args.engine) } : {}),
    });
    const prompt = text(args.prompt);
    if (prompt) {
      await this.deps.sessions.sendTurn(session, caller.userId, { text: prompt }, { by });
    }
    return {
      session_id: session.id,
      project_id: project.id,
      engine: session.engine,
      status: session.status,
      url: `${this.deps.env.publicUrl}/w/${project.workspaceId}/code/${project.id}?session=${session.id}`,
    };
  }

  private async callConnection(
    caller: PerchCaller,
    args: Record<string, unknown>,
    by: ActorContext,
  ) {
    const connectionId = text(args.connection);
    const tool = text(args.tool);
    if (!connectionId || !tool) throw PerchError.validation("say which connection and which tool");
    const workspaces = await this.workspaces(caller);
    for (const workspaceId of workspaces) {
      const connection = await this.deps.connections.connectionFor(
        workspaceId,
        caller.userId,
        connectionId,
      );
      if (!connection) continue;
      // The gateway's own path, audit included: the credential is attached there and never
      // travels back to the caller (AGENTS.md §1.6). The allow-list is not narrowed, because
      // `connectionFor` already answered the only question there is here — a personal connection
      // is its owner's and a workspace one is the workspace's. The per-subject grants of §3.5 are
      // for bots and sessions, which act on somebody's behalf; this token is the person.
      return this.deps.mcp.call({
        connection,
        allowList: null,
        tool,
        args: (args.args as Record<string, unknown>) ?? {},
        by,
        callerId: caller.userId,
      });
    }
    throw PerchError.notFound("connection");
  }

  /** A channel this caller can actually see, or the same answer a stranger gets. */
  private async channel(caller: PerchCaller, id: string | undefined): Promise<Channel> {
    if (!id) throw PerchError.validation("say which channel");
    const channel = await getChannel(this.deps.db.db, id);
    if (!channel) throw PerchError.notFound("channel");
    const workspaces = await this.workspaces(caller);
    if (!workspaces.includes(channel.workspaceId)) throw PerchError.notFound("channel");
    const visible = await listChannelsFor(this.deps.db.db, channel.workspaceId, caller.userId);
    if (!visible.some((one) => one.id === channel.id)) throw PerchError.notFound("channel");
    return channel;
  }

  private async project(caller: PerchCaller, id: string) {
    for (const workspaceId of await this.workspaces(caller)) {
      const project = await findProject(this.deps.db.db, workspaceId, id);
      if (project) return project;
    }
    throw PerchError.notFound("project");
  }

  /** Where a person would go to look at this, which is half of what an agent is for. */
  private link(workspaceId: string, channelId: string, messageId: string): string {
    return `${this.deps.env.publicUrl}/w/${workspaceId}/chat/${channelId}?m=${messageId}`;
  }
}

/** `admin` and `write` carry the narrower write scopes; `read` carries the read ones (spec §7.1). */
function allowed(caller: PerchCaller, scope: PerchTool["scope"]): boolean {
  const held = new Set<string>(caller.scopes);
  if (held.has(scope)) return true;
  if (held.has("admin")) return true;
  if (scope === "chat:read") return held.has("read") || held.has("write");
  return held.has("write") && scope !== "admin";
}

/** A message's blocks as the one line an agent can read. */
function plain(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) =>
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
