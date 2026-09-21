/**
 * The Bot API (spec §7.3; task 2.19).
 *
 * Slack-shaped on purpose: anybody who has written a Slack app can read `chat.postMessage` and
 * know what it does. What it is *not* is a second way into Perch — every call runs as the bot, in
 * the channels the bot is installed in, with the scopes its token was minted with, and everything
 * it does lands on the same bus as everything else. A bot posting `<@dawn>` triggers exactly the
 * mention path a person's message does, because it is the same path.
 *
 * Events go out on `@perch/bots`' own seam rather than the bus: the bus catalog is §7.7's list and
 * nothing else, and what a bot is handed is a different, outward-facing shape. This service is what
 * turns one into the other, so the socket and the webhook subscribe in one place.
 */

import type { AppMention, BotEvent, BotEvents, MessageCreated } from "@perch/bots";
import type { Bus } from "@perch/bus";
import type { Bot, BotScope, BotToken, Channel, Db, Message, MessageBlock } from "@perch/db";
import type { Logger } from "pino";
import { PerchError } from "../errors.ts";
import { findBotTokenByHash, touchBotToken } from "../repos/bot-tokens.ts";
import { botsInChannel, getBot, installsOf } from "../repos/bots.ts";
import { getChannel } from "../repos/channels.ts";
import { getConnection } from "../repos/connections.ts";
import {
  getMessage,
  insertMessage,
  listMessages,
  softDeleteMessage,
  updateMessageBlocks,
} from "../repos/messages.ts";
import { getSession } from "../repos/sessions.ts";
import { findUserById } from "../repos/users.ts";
import { getWorkItem } from "../repos/work.ts";
import type { ConnectionsService } from "./connections.ts";
import type { McpGateway } from "./mcp.ts";
import { getProject } from "./projects.ts";
import type { SessionService } from "./sessions.ts";
import { hashToken } from "./tokens.ts";
import { identifierOf } from "./work.ts";

/**
 * An unknown, revoked or expired token is nobody; which of the three it was is not a caller's
 * business. §7.8 has no `unauthorized` code, so this is `forbidden` at 401 — the status says
 * "authenticate", the code says what happened.
 */
function notAToken(): PerchError {
  return new PerchError("forbidden", "that bot token is not valid", { rule: "bot.token" }, 401);
}

export const BOT_TOKEN_PREFIX = "pbot_";

/** Spec §7.3: "Rate limit 60 req/min per bot with Retry-After on 429." */
export const BOT_RATE_LIMIT = 60;
export const BOT_RATE_WINDOW_MS = 60_000;

export type BotApiDeps = {
  db: Db;
  bus: Bus;
  botEvents: BotEvents;
  /** The gateway a bot's `tools.call` goes through; the credential stays in the vault. */
  mcp: McpGateway;
  /** Whether a connection was granted to this bot, and which of its tools (spec §3.5; task 3.3). */
  connections: Pick<ConnectionsService, "mayUse">;
  /** Where `sessions.open` lands (spec §7.3). */
  sessions: SessionService;
  log: Logger;
};

/** Who is calling: the bot, the token it used, and what that token may do. */
export type BotCaller = { bot: Bot; token: BotToken; scopes: BotScope[] };

export function botTokenValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${BOT_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
}

/** Enough to tell two tokens apart in a list, and useless to anybody who reads it. */
export function botTokenHint(token: string): string {
  return `${token.slice(0, BOT_TOKEN_PREFIX.length + 3)}…${token.slice(-4)}`;
}

/** The text of a message, for the `text` a Slack-shaped event carries beside its blocks. */
export function textOf(blocks: readonly MessageBlock[]): string {
  return blocks
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A message id doubles as its `ts`: monotonic, unique, and already what every route takes. */
function tsOf(message: Message): string {
  return message.id;
}

export class BotApiService {
  /** Per token: when the window started, and how many calls have been made in it. */
  private readonly calls = new Map<string, { since: number; count: number }>();

  constructor(private readonly deps: BotApiDeps) {}

  /**
   * The bot behind a `pbot_…` bearer. An unknown, revoked or expired token is nobody — the caller
   * gets the same 401 either way, because which of the three it was is not a caller's business.
   */
  async caller(bearer: string): Promise<BotCaller> {
    const token = bearer.startsWith(BOT_TOKEN_PREFIX)
      ? await findBotTokenByHash(this.deps.db, hashToken(bearer))
      : null;
    if (!token || (token.expiresAt && token.expiresAt.getTime() <= Date.now())) {
      throw notAToken();
    }
    const bot = await getBot(this.deps.db, token.botId);
    if (!bot) throw notAToken();
    if (bot.status !== "active") {
      throw PerchError.forbidden(`this bot is ${bot.status}`, { rule: "bot.status" });
    }
    await touchBotToken(this.deps.db, token.id);
    return { bot, token, scopes: token.scopes };
  }

  /** Spec §7.3's scopes: a call the token was not minted for is refused, not silently narrowed. */
  require(caller: BotCaller, scope: BotScope): void {
    if (!caller.scopes.includes(scope)) {
      throw PerchError.forbidden(`this token does not have ${scope}`, {
        rule: "bot.scope",
        scope,
      });
    }
  }

  /**
   * 60 calls a minute per bot, and the answer says how long to wait. A fixed window rather than a
   * sliding one: a bot that is rate limited should be able to reason about when it is not.
   */
  rateLimit(caller: BotCaller, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    const key = caller.bot.id;
    const seen = this.calls.get(key);
    if (!seen || now - seen.since >= BOT_RATE_WINDOW_MS) {
      this.calls.set(key, { since: now, count: 1 });
      return { ok: true };
    }
    if (seen.count >= BOT_RATE_LIMIT) {
      return { ok: false, retryAfter: Math.ceil((seen.since + BOT_RATE_WINDOW_MS - now) / 1_000) };
    }
    seen.count += 1;
    return { ok: true };
  }

  /** A channel the bot is installed in; anything else is not there as far as the bot is concerned. */
  async channelFor(caller: BotCaller, channelId: string): Promise<Channel> {
    const channel = await getChannel(this.deps.db, channelId);
    if (!channel || channel.workspaceId !== caller.bot.workspaceId) {
      throw PerchError.notFound("channel");
    }
    const installed = await botsInChannel(this.deps.db, channel.id);
    if (!installed.some((one) => one.bot.id === caller.bot.id))
      throw PerchError.notFound("channel");
    if (channel.archivedAt) throw PerchError.conflict("that channel is archived");
    return channel;
  }

  /** The channels this bot is in — which is exactly where it was installed. */
  async conversations(caller: BotCaller): Promise<Channel[]> {
    const installs = await installsOf(this.deps.db, caller.bot.id);
    const found: Channel[] = [];
    for (const install of installs) {
      const channel = await getChannel(this.deps.db, install.channelId);
      if (channel && !channel.archivedAt) found.push(channel);
    }
    return found;
  }

  async postMessage(
    caller: BotCaller,
    input: { channelId: string; blocks: MessageBlock[]; threadRootId?: string },
  ): Promise<Message> {
    const channel = await this.channelFor(caller, input.channelId);
    let threadRootId: string | null = null;
    if (input.threadRootId) {
      const root = await getMessage(this.deps.db, input.threadRootId);
      if (!root || root.channelId !== channel.id) throw PerchError.notFound("message");
      threadRootId = root.threadRootId ?? root.id;
    }
    const message = await insertMessage(this.deps.db, {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      threadRootId,
      authorType: "bot",
      authorId: caller.bot.id,
      blocks: input.blocks,
    });
    await this.deps.bus.publish(
      "message.created",
      {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        messageId: message.id,
        ...(threadRootId ? { threadRootId } : {}),
        authorType: "bot" as const,
        authorId: caller.bot.id,
      },
      { actor: { type: "bot", id: caller.bot.id }, meta: {} },
    );
    return message;
  }

  /** Its own messages only: a bot may not rewrite what somebody else said. */
  private async ownMessage(caller: BotCaller, messageId: string): Promise<Message> {
    const message = await getMessage(this.deps.db, messageId);
    if (!message || message.deletedAt) throw PerchError.notFound("message");
    if (message.authorType !== "bot" || message.authorId !== caller.bot.id) {
      throw PerchError.forbidden("that message is not this bot's", { rule: "bot.author" });
    }
    await this.channelFor(caller, message.channelId);
    return message;
  }

  async updateMessage(
    caller: BotCaller,
    messageId: string,
    blocks: MessageBlock[],
  ): Promise<Message> {
    const message = await this.ownMessage(caller, messageId);
    const updated = await updateMessageBlocks(this.deps.db, message, blocks, {
      type: "bot",
      id: caller.bot.id,
    });
    await this.deps.bus.publish(
      "message.updated",
      {
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        messageId: message.id,
      },
      { actor: { type: "bot", id: caller.bot.id }, meta: {} },
    );
    return updated;
  }

  async deleteMessage(caller: BotCaller, messageId: string): Promise<void> {
    const message = await this.ownMessage(caller, messageId);
    await softDeleteMessage(this.deps.db, message);
    await this.deps.bus.publish(
      "message.deleted",
      {
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        messageId: message.id,
      },
      { actor: { type: "bot", id: caller.bot.id }, meta: {} },
    );
  }

  async history(
    caller: BotCaller,
    input: { channelId: string; limit?: number; oldest?: string; latest?: string },
  ): Promise<Message[]> {
    const channel = await this.channelFor(caller, input.channelId);
    const rows = await listMessages(this.deps.db, channel.id, caller.bot.id, {
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.oldest ? { after: input.oldest } : {}),
      ...(input.latest ? { before: input.latest } : {}),
    });
    return rows;
  }

  async replies(caller: BotCaller, input: { ts: string; limit?: number }): Promise<Message[]> {
    const root = await getMessage(this.deps.db, input.ts);
    if (!root) throw PerchError.notFound("message");
    const channel = await this.channelFor(caller, root.channelId);
    const rows = await listMessages(this.deps.db, channel.id, caller.bot.id, {
      threadRootId: root.threadRootId ?? root.id,
      ...(input.limit ? { limit: input.limit } : {}),
    });
    return [root, ...rows.filter((one) => one.id !== root.id)];
  }

  /** A person, as a bot may know them: who they are, never how to be them. */
  async userInfo(userId: string) {
    const user = await findUserById(this.deps.db, userId);
    if (!user) throw PerchError.notFound("user");
    return { id: user.id, name: user.name, handle: user.handle };
  }

  /**
   * A connection's tool, through the MCP gateway (spec §7.3 `tools.call`). The bot never sees the
   * credential: the gateway holds it and this asks the gateway (AGENTS.md §1.6).
   */
  async callTool(
    caller: BotCaller,
    input: { connectionId: string; tool: string; args: Record<string, unknown> },
  ): Promise<unknown> {
    const connection = await getConnection(this.deps.db, input.connectionId);
    if (!connection || connection.workspaceId !== caller.bot.workspaceId) {
      throw PerchError.notFound("connection");
    }
    // A personal connection is its owner's, never a bot's (spec §3.6; task 2.14).
    if (connection.ownerType === "user") {
      throw PerchError.forbidden("that connection is personal", { rule: "connection.personal" });
    }
    // And a workspace connection is only this bot's if somebody granted it (spec §3.5 "workspace
    // connections are admin-created with explicit grants (bots, channels, tools)"; task 3.3). An
    // external bot is nobody's turn, so an `obo` grant refuses it here.
    const may = await this.deps.connections.mayUse({
      connection,
      subjectType: "bot",
      subjectId: caller.bot.id,
      invokedBy: null,
    });
    if (!may.ok) throw PerchError.forbidden(may.reason, { rule: "connection.grant" });
    // A tool the grant says needs a person's permission each time (task 3.6) has nobody to ask on
    // this path — the native runtime prompts the thread; an outside bot is refused instead.
    if (may.requiresPermission?.includes(input.tool)) {
      throw PerchError.forbidden("that tool needs a person's permission each time", {
        rule: "connection.permission",
        tool: input.tool,
      });
    }
    return this.deps.mcp.call({
      connection,
      allowList: may.allowedTools,
      tool: input.tool,
      args: input.args,
      by: { actor: { type: "bot", id: caller.bot.id }, meta: {} },
      callerId: caller.bot.id,
    });
  }

  /** An agent session in a project of this bot's workspace (spec §7.3 `sessions.open`). */
  async openSession(
    caller: BotCaller,
    input: { projectId: string; engine?: string; prompt?: string },
  ): Promise<{ id: string; status: string }> {
    const project = await getProject(this.deps.db, caller.bot.workspaceId, input.projectId);
    if (!project) throw PerchError.notFound("project");
    return this.deps.sessions.openForBot(caller.bot, project, {
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });
  }

  /**
   * The bus, translated into what a bot is handed (spec §7.3). Every bot installed in the channel
   * hears the message; the one whose handle was said also gets `app_mention`.
   */
  start(): () => void {
    const stops = [
      this.deps.bus.subscribe("message.created", (event) => {
        void this.onMessage(event.payload).catch((error: unknown) => {
          this.deps.log.error({ err: error }, "a bot event could not be delivered");
        });
      }),
      this.deps.bus.subscribe("reaction.added", (event) => {
        void this.onReaction(event.payload).catch((error: unknown) => {
          this.deps.log.error({ err: error }, "a bot event could not be delivered");
        });
      }),
      // Being put in a channel is the one thing a bot cannot find out by listening (§7.3
      // `channel.joined`): until it is installed it hears nothing from there at all.
      this.deps.bus.subscribe("bot.installed", (event) => {
        void this.onInstalled(event.payload).catch((error: unknown) => {
          this.deps.log.error({ err: error }, "a bot event could not be delivered");
        });
      }),
      this.deps.bus.subscribe("session.status", (event) => {
        void this.onSession(event.payload).catch((error: unknown) => {
          this.deps.log.error({ err: error }, "a bot event could not be delivered");
        });
      }),
      // What moved on the board, for the bots that watch it (spec §7.3; task 3.13).
      this.deps.bus.subscribe("work_item.updated", (event) => {
        void this.onWorkItem(event.payload).catch((error: unknown) => {
          this.deps.log.error({ err: error }, "a bot event could not be delivered");
        });
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  private async onMessage(payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    threadRootId?: string;
    authorType: "user" | "bot" | "system";
    authorId: string;
  }): Promise<void> {
    const message = await getMessage(this.deps.db, payload.messageId);
    if (!message || message.deletedAt) return;
    const channel = await getChannel(this.deps.db, payload.channelId);
    if (!channel) return;
    const installed = await botsInChannel(this.deps.db, channel.id);
    if (installed.length === 0) return;
    const author = await this.actorOf(payload.authorType, payload.authorId);
    const text = textOf(message.blocks);
    const said = new Set(mentionedHandles(text));
    const base: MessageCreated = {
      workspace_id: channel.workspaceId,
      channel_id: channel.id,
      channel_name: channel.name,
      message_id: message.id,
      thread_root_id: message.threadRootId,
      text,
      blocks: message.blocks as MessageCreated["blocks"],
      user: author,
      ts: tsOf(message),
    };
    for (const { bot } of installed) {
      // A bot does not hear itself: an echo is not an event.
      if (payload.authorType === "bot" && payload.authorId === bot.id) continue;
      await this.emit({ type: "message.created", botId: bot.id, payload: base });
      if (!said.has(bot.handle.toLowerCase())) continue;
      const mention: AppMention = {
        ...base,
        mentioned_by: author,
        mode: null,
        root_id: message.threadRootId ?? message.id,
        hop: payload.authorType === "bot" ? 1 : 0,
        budget_remaining: null,
      };
      await this.emit({ type: "app_mention", botId: bot.id, payload: mention });
    }
  }

  private async onReaction(payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    emoji: string;
    memberType: "user" | "bot";
    memberId: string;
  }): Promise<void> {
    const installed = await botsInChannel(this.deps.db, payload.channelId);
    if (installed.length === 0) return;
    const user = await this.actorOf(payload.memberType, payload.memberId);
    for (const { bot } of installed) {
      if (payload.memberType === "bot" && payload.memberId === bot.id) continue;
      await this.emit({
        type: "reaction.added",
        botId: bot.id,
        payload: {
          workspace_id: payload.workspaceId,
          channel_id: payload.channelId,
          message_id: payload.messageId,
          emoji: payload.emoji,
          user,
          ts: new Date().toISOString(),
        },
      });
    }
  }

  private async onInstalled(payload: {
    workspaceId: string;
    botId: string;
    channelId: string;
  }): Promise<void> {
    const channel = await getChannel(this.deps.db, payload.channelId);
    if (!channel) return;
    await this.emit({
      type: "channel.joined",
      botId: payload.botId,
      payload: {
        workspace_id: payload.workspaceId,
        channel_id: channel.id,
        channel_name: channel.name,
        ts: new Date().toISOString(),
      },
    });
  }

  private async onSession(payload: {
    workspaceId: string;
    sessionId: string;
    status: string;
  }): Promise<void> {
    if (payload.status !== "ended" && payload.status !== "error") return;
    const session = await getSession(this.deps.db, payload.sessionId);
    if (!session) return;
    await this.emit({
      type: "session.completed",
      botId: null,
      payload: {
        workspace_id: payload.workspaceId,
        session_id: payload.sessionId,
        project_id: session.projectId,
        status: payload.status,
        message: session.statusMessage,
        ts: new Date().toISOString(),
      },
    });
  }

  private async onWorkItem(payload: {
    workspaceId: string;
    projectId: string;
    workItemId: string;
    changes?: string[];
  }): Promise<void> {
    const item = await getWorkItem(this.deps.db, payload.workItemId);
    if (!item) return;
    const project = await getProject(this.deps.db, item.workspaceId, item.projectId);
    if (!project) return;
    await this.emit({
      type: "work_item.updated",
      botId: null,
      payload: {
        workspace_id: item.workspaceId,
        project_id: item.projectId,
        work_item_id: item.id,
        identifier: identifierOf(project.key, item.number),
        title: item.title,
        state: item.state,
        changes: payload.changes ?? [],
        assignee_type: item.assigneeType,
        assignee_id: item.assigneeId,
        ts: new Date().toISOString(),
      },
    });
  }

  private async emit<T extends BotEvent["type"]>(
    event: Pick<Extract<BotEvent, { type: T }>, "type" | "botId" | "payload">,
  ): Promise<void> {
    await this.deps.botEvents.emit({
      ...event,
      workspaceId: (event.payload as { workspace_id: string }).workspace_id,
      ts: new Date().toISOString(),
    } as BotEvent);
  }

  private async actorOf(type: "user" | "bot" | "system", id: string) {
    if (type === "bot") {
      const bot = await getBot(this.deps.db, id);
      return { type: "bot" as const, id, ...(bot ? { name: bot.name, handle: bot.handle } : {}) };
    }
    const user = await findUserById(this.deps.db, id);
    return {
      type: "user" as const,
      id,
      ...(user ? { name: user.name, ...(user.handle ? { handle: user.handle } : {}) } : {}),
    };
  }
}

/** Every `@handle` in a line of text, lower case. */
export function mentionedHandles(text: string): string[] {
  return [...text.matchAll(/<@([a-z0-9_-]+)>|(?:^|\s)@([a-z0-9_-]+)/gi)]
    .map((match) => (match[1] ?? match[2] ?? "").toLowerCase())
    .filter(Boolean);
}
