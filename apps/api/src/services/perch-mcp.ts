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
import {
  type ApiTokenScopes,
  type Channel,
  type DbHandle,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  type WorkItem,
  type WorkItemState,
  type WorkItemType,
} from "@perch/db";
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
import { viewWorkItem, type WorkService } from "./work.ts";

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

/** The seven tools §7.5 names. */
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
    name: "work.create",
    description:
      "Add a work item to a project's board: what needs doing, and who or which bot should do it.",
    scope: "work:write",
    inputSchema: {
      type: "object",
      properties: {
        project: str("The project id."),
        title: str("One line: what needs doing."),
        description: str("The detail, if there is any."),
        type: str("task (the default), bug, feature or epic."),
        state: str("Where it starts. backlog by default."),
        priority: { type: "number", description: "0 none, 1 urgent … 4 low." },
      },
      required: ["project", "title"],
    },
  },
  {
    name: "work.update",
    description:
      "Change a work item: move it on the board, reassign it, retitle it, or put a pull request on it.",
    scope: "work:write",
    inputSchema: {
      type: "object",
      properties: {
        item: str("The work item id, or KEY-123."),
        state: str("backlog, queued, running, needs_you, in_review, done or cancelled."),
        title: str("A new title."),
        description: str("A new description."),
        priority: { type: "number", description: "0 none, 1 urgent … 4 low." },
        pr_url: str("The pull request that did it."),
      },
      required: ["item"],
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
  work: WorkService;
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
      case "work.create":
        return json(await this.createWork(caller, args, by));
      case "work.update":
        return json(await this.updateWork(caller, args, by));
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

  private async createWork(caller: PerchCaller, args: Record<string, unknown>, by: ActorContext) {
    const projectId = text(args.project);
    const title = text(args.title);
    if (!projectId || !title) throw PerchError.validation("say which project, and a title");
    const project = await this.project(caller, projectId);
    const item = await this.deps.work.create({
      project,
      userId: caller.userId,
      title,
      // An agent asking for work to exist is `bot` however it got here: it is not a person typing.
      source: "bot",
      by,
      ...(text(args.description) ? { description: text(args.description) } : {}),
      ...(isType(args.type) ? { type: args.type } : {}),
      ...(isState(args.state) ? { state: args.state } : {}),
      ...(typeof args.priority === "number" ? { priority: Math.trunc(args.priority) } : {}),
    });
    return viewWorkItem(item, project.key);
  }

  private async updateWork(caller: PerchCaller, args: Record<string, unknown>, by: ActorContext) {
    const item = await this.workItem(caller, text(args.item));
    const project = await this.deps.work.projectOf(item);
    const updated = await this.deps.work.update(
      item,
      {
        ...(isState(args.state) ? { state: args.state } : {}),
        ...(text(args.title) ? { title: text(args.title) } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(typeof args.priority === "number" ? { priority: Math.trunc(args.priority) } : {}),
        ...(text(args.pr_url) ? { prUrl: text(args.pr_url) } : {}),
      },
      by,
    );
    return viewWorkItem(updated, project.key);
  }

  /** By its id, or by the `KEY-123` a person would have said (spec §7.8). */
  private async workItem(caller: PerchCaller, ref: string | undefined): Promise<WorkItem> {
    if (!ref) throw PerchError.validation("say which work item");
    const workspaces = await this.workspaces(caller);
    const direct = UUID.test(ref) ? await this.deps.work.item(ref) : null;
    if (direct && workspaces.includes(direct.workspaceId)) return direct;
    const named = /^([A-Za-z][\w-]*)-(\d+)$/.exec(ref);
    if (named?.[1] && named[2]) {
      const found = await this.deps.work.byIdentifier(workspaces, named[1], Number(named[2]));
      if (found) return found;
    }
    throw PerchError.notFound("work item");
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isState(value: unknown): value is WorkItemState {
  return typeof value === "string" && (WORK_ITEM_STATES as readonly string[]).includes(value);
}

function isType(value: unknown): value is WorkItemType {
  return typeof value === "string" && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
