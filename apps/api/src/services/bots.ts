/**
 * The native bot runtime as the api sees it (spec §5.3; task 2.6).
 *
 * `packages/bots` owns the parts that are the same everywhere — which trigger fires, which tools a
 * bot has, what a turn costs, how a reply streams. This is the half that touches Perch: the bot as
 * a member of a channel, the placeholder message it edits into its answer, the brain it runs on,
 * and the ledger a budget is checked against.
 *
 * A bot's turn never happens inside the request that caused it. Somebody says something, the api
 * answers them, and the bot's run goes on in the background — which is also why the answer arrives
 * as a message that fills in rather than a response somebody waited for.
 */

import type { Span } from "@opentelemetry/api";
import {
  type AttachedServer,
  type BotEvents,
  type BotHost,
  type BotReply,
  budgetLeft,
  type ChainState,
  type ChatLine,
  DEFAULT_MAX_HOPS,
  firesOn,
  type InteractionReceived,
  inScope,
  type MemoryHit,
  mayHop,
  mcpTools,
  runBot,
  type SearchHit,
  schedules,
  spent,
  summarize,
  type ToolSet,
  type TriggerEvent,
  toolsFor,
  triggersProblem,
  withinBudget,
  wrapResult,
} from "@perch/bots";
import { type CodeBotEvent, type CodeBotTools, runCodeBot } from "@perch/bots/sandbox";
import type { Bus } from "@perch/bus";
import type {
  Bot,
  BotChain,
  BotInstall,
  BotRun,
  BotSpec,
  BotTool,
  BotToolCall,
  ChainMode,
  Channel,
  Connection,
  Db,
  Message,
  MessageBlock,
  ThreadFactValue,
} from "@perch/db";
import type { ModelMessage } from "@perch/gateway";
import type { Queue } from "@perch/jobs";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  botByHandle,
  botsByHandles,
  botsByIds,
  botsInChannel,
  chainOf,
  channelForBot,
  decideBotToolCall,
  deleteBot,
  findInstall,
  finishHop,
  finishRun,
  getBot,
  getBotToolCall,
  insertBot,
  insertBotToolCall,
  installBot,
  installsOf,
  keepMemory,
  markBotToolCall,
  recallMemories,
  spending,
  startHop,
  startRun,
  uninstallBot,
  updateBot,
} from "../repos/bots.ts";
import { addMember, findBotDm, getChannel, insertChannel } from "../repos/channels.ts";
import { getConnection, workspaceConnections } from "../repos/connections.ts";
import { listMcpServers } from "../repos/mcp-servers.ts";
import {
  getMessage,
  getMessageRow,
  insertMessage,
  listMessages,
  type MessageRow,
  updateMessageBlocks,
} from "../repos/messages.ts";
import { threadFactsOf, upsertThreadFacts } from "../repos/threads.ts";
import { handleTaken } from "../repos/users.ts";
import { ids, spanUnder, tracer } from "../telemetry/tracing.ts";
import type { BrainsService } from "./brains.ts";
import type { BudgetsService } from "./budgets.ts";
import type { ConnectionsService } from "./connections.ts";
import type { LocalMcpService } from "./local-mcp.ts";
import type { McpGateway } from "./mcp.ts";
import type { ModelGatewayService } from "./model-gateway.ts";
import type { PolicyService } from "./policy.ts";

/** What the rails say about a bot hearing a mention over the Bot API (`mentionRails`). */
export type MentionRails =
  | { ok: true; hop: number; mode: ChainMode | null; budgetRemaining: number | null }
  | { ok: false; reason: string };

/** How many tags' modes are kept for the bots they are offered to. */
const MODES_KEPT = 1_000;

export type BotsDeps = {
  db: Db;
  bus: Bus;
  botEvents: BotEvents;
  brains: BrainsService;
  /** What may happen here (spec §5.7): the channel's models, the ceilings, the bot rails. */
  policy: PolicyService;
  /** Where a bot's scheduled triggers live (spec §5.3 `schedule (cron)`). */
  queue: Queue;
  log: Logger;
  /** The search endpoint a bot's web_search uses, when this Perch has one. */
  search?: { url: string; key: string | undefined } | undefined;
  /** Whether an attached connection is this bot's to use (spec §3.5; task 3.6). */
  connections?: Pick<ConnectionsService, "mayUse"> | undefined;
  /** The gateway an attached MCP server is reached through; the credential stays in the vault. */
  mcp?: Pick<McpGateway, "tools" | "call"> | undefined;
  /** The MCP servers a runner hosts itself, which a bot attaches like any other (task 3.24). */
  localMcp?: Pick<LocalMcpService, "tools" | "call"> | undefined;
  /** What an agent bot opens a session with (spec §5.3 "Agent bots"; task 3.7). */
  agents?: AgentSessions | undefined;
  /** The workspace's ceilings, above this bot's own (task 4.2). */
  budgets?: Pick<BudgetsService, "check"> | undefined;
  /** The ledger every model call is written to, so one query answers what a workspace spent. */
  usage?: Pick<ModelGatewayService, "record"> | undefined;
};

/**
 * The half of an agent bot that is a coding session (spec §5.3 `engine: opencode|acp + projects`).
 *
 * The bots service knows a mention should become a session; it does not know what a session is.
 * Boot closes this over the session service, which keeps `packages/bots` and this file free of
 * engines, runners and worktrees.
 */
export type AgentSessions = {
  /** Opens one on this project, in this thread, and answers with what the card should say. */
  open(input: {
    bot: Bot;
    channel: Channel;
    threadRootId: string | null;
    projects: readonly string[];
    engine: string;
    prompt: string;
  }): Promise<{ sessionId: string; project: string; status: string; url: string }>;
};

export type BotsOptions = {
  /** Tests wait for what a message set off; nothing else needs to. */
  onIdle?: () => void;
  /** How often a streaming reply rewrites its message. */
  editEveryMs?: number;
};

/** What a bot was asked, and where the answer goes. */
export type RunInput = {
  bot: Bot;
  channel: Channel;
  trigger: string;
  triggerRef?: string | undefined;
  /** The message that set it off, when one did. */
  message?: Message | undefined;
  /** Where it was installed, when the run comes from a channel: its scopes narrow the tools. */
  install?: BotInstall | undefined;
  /** The hop this run is (spec §5.4), when somebody tagged the bot rather than asking it directly. */
  chain?: BotChain | undefined;
  /** A run with no message of its own: a schedule, or the Forge's test chat. */
  prompt?: string | undefined;
  by: ActorContext;
  /** The answer is posted where it was asked; a test run keeps it to itself. */
  quiet?: boolean;
};

export type RunOutcome = { run: BotRun; text: string };

const DEFAULT_WINDOW = 20;
/** Both lists, narrowed: the grant decides, and a bot's spec may only ask for less (task 3.6). */
export function narrowTools(grant: string[] | null, asked: string[] | null): string[] | null {
  if (!grant) return asked;
  if (!asked) return grant;
  return grant.filter((one) => asked.includes(one));
}

/** How late a missed firing may be and still run, when the trigger does not say (task 3.5). */
export const DEFAULT_CATCH_UP_MINUTES = 60;
const PLACEHOLDER = "…";
/** The queue a bot's scheduled triggers run on. */
export const BOT_QUEUE = "bots";
/**
 * The thread's own switch (spec §5.4 "/stop halts all bots in the thread; /resume continues"), kept
 * where the rest of a thread's shared state is rather than in a table of its own.
 */
/** How long a bot waits for the bots it tagged, and how often it looks (spec §5.4 fan-out). */
const WAIT_MS = 60_000;
const WAIT_POLL_MS = 250;
const STOPPED = "chain.stopped";
const BREAKER = "chain.breaker";
/** What a person allowed this thread to spend when they let it carry on (spec §5.4 Continue). */
const ALLOWANCE = "chain.allowance";
/** What a fan-out promised each specialist, by bot id (spec §5.4 "split across hops"; task 3.10). */
const SHARES = "chain.shares";
/** What the intervene card asks (spec §5.4 "Continue/Stop"). */
const INTERVENE_ACTION = "chain.intervene";
/** What the permission card asks (spec §3.5 "pending + inbox item, completes on approval"). */
export const TOOL_CALL_ACTION = "connection.tool_call";
/** A spec may carry at most this many triggers (the shape caps it at 20). */
const MAX_SCHEDULES = 20;

function textOf(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => ("text" in block && block.text ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** The handles a message named, lower case: what the mention trigger matches on. */
export function mentionsIn(text: string): string[] {
  return [...text.matchAll(/<@([a-z0-9._-]{1,64})>|(?:^|[\s(])@([a-z0-9._-]{1,64})/gi)].map(
    (match) => (match[1] ?? match[2] ?? "").toLowerCase(),
  );
}

/**
 * A thread fact back as a share table (task 3.10). jsonb is `unknown` until something checks it,
 * and a malformed one is no shares rather than a crash mid-chain.
 */
export function shareTable(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [id, share] of Object.entries(value as Record<string, unknown>)) {
    if (typeof share === "number" && Number.isFinite(share) && share >= 0) out[id] = share;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * What was asked, without the naming of who was asked (task 3.7). "@dawn add a dark-mode toggle"
 * is a prompt for an engine only once `@dawn` is out of it: the engine has never heard of dawn.
 */
export function withoutMentions(text: string): string {
  return text
    .replace(/<@[a-z0-9._-]{1,64}>/gi, " ")
    .replace(/(^|[\s(])@[a-z0-9._-]{1,64}/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A URL a bot may fetch. Everything that resolves inside the network Perch runs on is refused:
 * a bot is not a way to reach the metadata service, the database, or a neighbour's port (§1.6).
 */
export function fetchable(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw PerchError.validation("that is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw PerchError.validation("only http and https can be fetched");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateName =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const privateV4 = (() => {
    if (!v4) return false;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  })();
  const privateV6 =
    host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  if (privateName || privateV4 || privateV6) {
    throw PerchError.validation("that address is not reachable from a bot");
  }
  return url;
}

export class BotsService {
  private readonly inflight = new Set<Promise<unknown>>();
  /**
   * The kill switch (task 3.19): one controller per run in flight, so `stop` reaches the model
   * call itself rather than only marking a row. A run that has already finished has no entry, and
   * stopping it is a no-op rather than an error.
   */
  private readonly stopping = new Map<string, AbortController>();
  /**
   * How a tag was meant (spec §5.4 consult, handoff, fan-out). The mention travels as an ordinary
   * message, so the mode is remembered beside it until the hop it causes is recorded.
   */
  private readonly modes = new Map<string, ChainMode>();

  constructor(
    private readonly deps: BotsDeps,
    private readonly options: BotsOptions = {},
  ) {}

  /**
   * A bot's scheduled triggers, as rows in the queue (spec §5.3 "schedule (cron)"). The key is the
   * bot and the trigger's place in its list, so saving a spec again moves the schedule rather than
   * adding a second one, and a trigger that is gone takes its row with it.
   */
  async reschedule(bot: Bot): Promise<string[]> {
    const wanted = schedules(bot.spec);
    const keys: string[] = [];
    for (const [index, trigger] of wanted.entries()) {
      const key = `bot:${bot.id}:${index}`;
      keys.push(key);
      if (bot.status !== "active" || !trigger.cron) {
        await this.deps.queue.unschedule(key);
        continue;
      }
      await this.deps.queue.schedule({
        key,
        queue: BOT_QUEUE,
        cron: trigger.cron,
        // Nine in the morning where the person who wrote it lives (task 3.5).
        ...(bot.spec.timezone ? { timezone: bot.spec.timezone } : {}),
        payload: { botId: bot.id, index },
      });
    }
    // Anything beyond what the spec now says is no longer a trigger.
    for (let index = wanted.length; index < MAX_SCHEDULES; index += 1) {
      await this.deps.queue.unschedule(`bot:${bot.id}:${index}`);
    }
    return keys;
  }

  /** The queue's side of a scheduled trigger; the worker hands the job over. */
  jobHandlers(): Record<
    string,
    (job: { payload: Record<string, unknown>; runAt?: Date }) => Promise<void>
  > {
    return {
      [BOT_QUEUE]: (job) => this.runScheduled(job.payload, job.runAt ? { due: job.runAt } : {}),
    };
  }

  /** One firing of a cron trigger: the prompt it carries, in the channel it names. */
  async runScheduled(
    payload: Record<string, unknown>,
    options: { due?: Date; now?: Date } = {},
  ): Promise<void> {
    const botId = typeof payload.botId === "string" ? payload.botId : "";
    const index = typeof payload.index === "number" ? payload.index : -1;
    const bot = botId ? await getBot(this.deps.db, botId) : null;
    if (bot?.status !== "active") return;
    const trigger = schedules(bot.spec)[index];
    if (!trigger) return;
    // A firing Perch was not up for (task 3.5). Running it late is right for a digest somebody
    // still wants and wrong for "good morning", so the trigger says which.
    if (options.due && !worthRunning(trigger, options.due, options.now ?? new Date())) {
      this.deps.log.info(
        { botId: bot.id, cron: trigger.cron, due: options.due.toISOString() },
        "a scheduled trigger was missed and is not worth catching up",
      );
      return;
    }
    // The channel the trigger names, or — when it names none — the first one the bot is in.
    const named = trigger.channel
      ? await channelForBot(this.deps.db, bot.id, trigger.channel)
      : null;
    const channelId = named?.id ?? (await installsOf(this.deps.db, bot.id))[0]?.channelId ?? null;
    const channel = channelId ? await getChannel(this.deps.db, channelId) : null;
    if (!channel) {
      this.deps.log.warn({ botId: bot.id }, "a scheduled trigger has nowhere to post");
      return;
    }
    await this.run({
      bot,
      channel,
      trigger: "schedule",
      triggerRef: trigger.cron ?? "",
      prompt: trigger.prompt ?? "It is time.",
      by: botActor(bot.id),
    });
  }

  /** The chain of a thread, with the names a header needs (task 2.7). */
  async chain(threadRootId: string): Promise<ChainView> {
    const hops = await chainOf(this.deps.db, threadRootId);
    const ids = new Set<string>();
    for (const hop of hops) {
      ids.add(hop.toBotId);
      if (hop.fromType === "bot") ids.add(hop.fromId);
    }
    const named = await botsByIds(this.deps.db, [...ids]);
    const facts = await threadFactsOf(this.deps.db, threadRootId);
    const breaker = facts[BREAKER];
    return {
      hops: hops.map((hop) => ({
        id: hop.id,
        hop: hop.hop,
        fromType: hop.fromType,
        fromId: hop.fromId,
        fromName: hop.fromType === "bot" ? (named.get(hop.fromId)?.name ?? null) : null,
        toBotId: hop.toBotId,
        toName: named.get(hop.toBotId)?.name ?? null,
        mode: hop.mode,
        status: hop.status,
        costUsd: Number(hop.costUsd),
        at: hop.createdAt.toISOString(),
      })),
      costUsd: Math.round(hops.reduce((total, hop) => total + Number(hop.costUsd), 0) * 1e6) / 1e6,
      stopped: facts[STOPPED] === true,
      breaker: typeof breaker === "string" && breaker !== "" ? breaker : null,
    };
  }

  /** Where a bot has been put. */
  installsOf(botId: string): Promise<BotInstall[]> {
    return installsOf(this.deps.db, botId);
  }

  /**
   * Stop a run that is in flight (spec §5.7 "agent presence … with a kill switch"; task 3.19).
   * Returns false when there was nothing to stop, which is the honest answer for a run that
   * finished a moment ago.
   */
  stop(runId: string): boolean {
    const controller = this.stopping.get(runId);
    if (!controller) return false;
    controller.abort(new Error("stopped"));
    return true;
  }

  /** Everything a message set off, once it has finished. For tests and for shutdown. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /**
   * The bus is where a bot hears things (spec §9.1: features never reach into each other). Every
   * message on the workspace's topic is offered to the bots installed in that channel, and the one
   * whose trigger fires answers.
   */
  start(): () => void {
    const stops = [
      this.deps.bus.subscribe("message.created", (event) => {
        this.track(this.onMessage(event.payload));
      }),
      this.deps.bus.subscribe("reaction.added", (event) => {
        this.track(this.onReaction(event.payload));
      }),
      // The intervene card's answer comes back on the Bot API seam (task 2.5), like any other.
      this.deps.botEvents.subscribe((event) => {
        if (event.type !== "interaction.received") return;
        const payload = event.payload as InteractionReceived;
        if (payload.action === TOOL_CALL_ACTION) {
          this.track(this.decided(payload));
          return;
        }
        if (payload.action !== INTERVENE_ACTION) return;
        this.track(this.intervened(payload.block_id, payload.values.decision ?? ""));
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  private track(work: Promise<unknown>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.deps.log.error({ err: error }, "a bot run failed");
      })
      .finally(() => {
        this.inflight.delete(tracked);
        if (this.inflight.size === 0) this.options.onIdle?.();
      });
    this.inflight.add(tracked);
  }

  private async onMessage(payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    authorType: "user" | "bot" | "system";
    authorId: string;
  }): Promise<void> {
    const message = await getMessage(this.deps.db, payload.messageId);
    if (!message || message.deletedAt) return;
    const channel = await getChannel(this.deps.db, payload.channelId);
    if (!channel || channel.archivedAt) return;
    const text = textOf(message.blocks);
    const event: TriggerEvent = {
      kind: "message",
      channelId: channel.id,
      channelType: channel.type,
      text,
      mentions: mentionsIn(text),
      authorType: payload.authorType,
      authorId: payload.authorId,
    };
    await this.offer(channel, event, message);
  }

  private async onReaction(payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    emoji: string;
    memberType: "user" | "bot";
    memberId: string;
  }): Promise<void> {
    const channel = await getChannel(this.deps.db, payload.channelId);
    if (!channel || channel.archivedAt) return;
    const message = await getMessage(this.deps.db, payload.messageId);
    if (!message) return;
    await this.offer(
      channel,
      {
        kind: "reaction",
        channelId: channel.id,
        emoji: payload.emoji,
        authorType: payload.memberType,
        authorId: payload.memberId,
      },
      message,
    );
  }

  /**
   * The MCP servers this bot's spec names, narrowed by what it was granted (spec §5.3, §3.5; task
   * 3.6). A connection nobody granted it contributes nothing, and says so in the log: a bot with a
   * hopeful spec should be quiet rather than broken.
   */
  private async attachedTools(
    bot: Bot,
    channel: Channel,
    input: RunInput,
    /** The run's span: a tool the bot reaches for belongs inside it (task 3.22). */
    run: Span,
  ): Promise<ToolSet> {
    const wanted = bot.spec.mcp ?? [];
    if (wanted.length === 0 || !this.deps.connections || !this.deps.mcp) return {};
    const rows = await workspaceConnections(this.deps.db, bot.workspaceId);
    const servers: AttachedServer[] = [];
    // The runner-local ones, which a spec names by id like anything else (task 3.24).
    const local = this.deps.localMcp ? await listMcpServers(this.deps.db, bot.workspaceId) : [];
    // Whose turn this is: an `obo` grant is only good for the person the connection belongs to.
    const invokedBy = input.by.actor.type === "user" ? (input.by.actor.id ?? null) : null;
    for (const entry of wanted) {
      const hosted = local.find(
        (row) => row.id === entry.connection || row.name === entry.connection,
      );
      const localMcp = this.deps.localMcp;
      if (hosted && localMcp) {
        // No grant and no credential: what gates a local server is the workspace it belongs to,
        // this spec naming it, and the runner's own policy on the command (ADR-0142).
        const narrowed = entry.tools ?? null;
        const owner = bot.ownerId;
        const upstream = await localMcp.tools(hosted, narrowed, owner).catch((error: unknown) => {
          this.deps.log.warn(
            { err: error, mcpServerId: hosted.id },
            "a runner-local MCP server would not list its tools",
          );
          return [];
        });
        servers.push({
          provider: hosted.name,
          tools: upstream.map((one) => ({ name: one.name, description: one.description })),
          needsPerson: () => false,
          call: async (name: string, args: Record<string, unknown>) =>
            await spanUnder(
              run,
              `tool.${name}`,
              {
                "perch.tool": name,
                "perch.provider": hosted.name,
                ...ids({ workspaceId: channel.workspaceId, botId: bot.id }),
              },
              async () =>
                await localMcp.call({
                  server: hosted,
                  allowList: narrowed,
                  tool: name,
                  args,
                  by: input.by,
                  callerId: bot.id,
                  userId: owner,
                }),
            ),
          ask: async () => "a runner-local server has nothing to ask a person about",
        });
        continue;
      }
      const connection =
        rows.find((row) => row.id === entry.connection) ??
        rows.find((row) => row.provider === entry.connection);
      if (!connection) continue;
      const may = await this.deps.connections.mayUse({
        connection,
        subjectType: "bot",
        subjectId: bot.id,
        invokedBy,
      });
      if (!may.ok) {
        this.deps.log.info(
          { botId: bot.id, connectionId: connection.id, reason: may.reason },
          "a bot's attached connection is not its to use",
        );
        continue;
      }
      // The grant decides; the spec may ask for less and never for more.
      const allowList = narrowTools(may.allowedTools, entry.tools ?? null);
      const needs = new Set(may.requiresPermission ?? []);
      const upstream = await this.deps.mcp.tools(connection, allowList).catch((error: unknown) => {
        this.deps.log.warn(
          { err: error, connectionId: connection.id },
          "an attached MCP server would not list its tools",
        );
        return [];
      });
      servers.push({
        provider: connection.provider,
        tools: upstream.map((one) => ({ name: one.name, description: one.description })),
        needsPerson: (name: string) => needs.has(name),
        // A span per tool the bot actually calls (task 3.22): the name and the provider, never
        // the arguments — a tool's arguments are the conversation.
        call: async (name: string, args: Record<string, unknown>) =>
          await spanUnder(
            run,
            `tool.${name}`,
            {
              "perch.tool": name,
              "perch.provider": connection.provider,
              ...ids({ workspaceId: channel.workspaceId, botId: bot.id }),
            },
            async () =>
              await this.deps.mcp?.call({
                connection,
                allowList,
                tool: name,
                args,
                by: input.by,
                callerId: bot.id,
              }),
          ),
        ask: async (name: string, args: Record<string, unknown>) =>
          await this.askPermission(bot, channel, input, connection, name, args),
      });
    }
    return mcpTools(servers);
  }

  /**
   * A tool a person has to say yes to (spec §3.5 "returns pending + inbox item, completes on
   * approval"). The turn does not wait: the call is written down, the person finds it in their
   * inbox, and the answer arrives in the thread when they have decided.
   */
  private async askPermission(
    bot: Bot,
    channel: Channel,
    input: RunInput,
    connection: Connection,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const threadRootId = input.message?.threadRootId ?? input.message?.id ?? null;
    const requestedBy = input.by.actor.type === "user" ? (input.by.actor.id ?? null) : null;
    const row = await insertBotToolCall(this.deps.db, {
      workspaceId: bot.workspaceId,
      botId: bot.id,
      channelId: channel.id,
      threadRootId,
      connectionId: connection.id,
      requestedBy,
      tool: name,
      args,
    });
    // The card is where a person answers it (spec §5.3 "write-tools prompt for permission in
    // shared channels"); the inbox item the event raises is the same question on their phone.
    await this.post(channel, threadRootId, bot, [
      {
        type: "approve_deny",
        id: `${TOOL_CALL_ACTION}:${row.id}`,
        action: TOOL_CALL_ACTION,
        text: `${bot.name} wants to call ${connection.provider}/${name}`,
      },
    ]);
    await this.deps.bus.publish(
      "bot.permission_requested",
      {
        workspaceId: bot.workspaceId,
        botId: bot.id,
        callId: row.id,
        channelId: channel.id,
        tool: `${connection.provider}/${name}`,
        requestedBy,
      },
      input.by,
    );
    return `Asked a person to approve ${connection.provider}/${name}. Nothing has happened yet; say so and stop.`;
  }

  /**
   * A person answered (spec §3.5 "completes on approval"). Approving runs the call the bot parked
   * — through the gateway, so the credential is still the connection's and still in the vault —
   * and posts what came back in the thread the bot was asked in. Denying says so and stops.
   *
   * Whoever answers first is who it says: the row moves out of `pending` in one statement, so two
   * people pressing Approve run the call once.
   */
  async decideToolCall(input: {
    callId: string;
    decision: "approved" | "denied";
    userId: string;
    by: ActorContext;
  }): Promise<BotToolCall> {
    const call = await getBotToolCall(this.deps.db, input.callId);
    if (!call) throw PerchError.notFound("tool call");
    if (call.status !== "pending") throw PerchError.conflict("somebody has already answered that");
    const claimed = await decideBotToolCall(this.deps.db, call.id, {
      status: input.decision === "denied" ? "denied" : "done",
      decidedBy: input.userId,
    });
    if (!claimed) throw PerchError.conflict("somebody has already answered that");
    const bot = await getBot(this.deps.db, call.botId);
    const channel = await getChannel(this.deps.db, call.channelId);
    const answered = async (text: string, outcome: BotToolCall["status"], error?: string) => {
      if (bot && channel)
        await this.post(channel, call.threadRootId, bot, [{ type: "text", text }]);
      await this.deps.bus.publish(
        "bot.permission_answered",
        {
          workspaceId: call.workspaceId,
          botId: call.botId,
          callId: call.id,
          decision: input.decision,
        },
        input.by,
      );
      return outcome === "done" && !error
        ? claimed
        : ((await markBotToolCall(this.deps.db, call.id, { status: outcome, error })) ?? claimed);
    };
    const connection = await getConnection(this.deps.db, call.connectionId);
    if (input.decision === "denied" || !connection) {
      return await answered(
        input.decision === "denied"
          ? `Not doing ${call.tool}: somebody said no.`
          : `Could not do ${call.tool}: that connection is gone.`,
        input.decision === "denied" ? "denied" : "error",
        input.decision === "denied" ? undefined : "connection is gone",
      );
    }
    if (!this.deps.connections || !this.deps.mcp) {
      return await answered(
        `Could not do ${call.tool}: nothing here can reach it.`,
        "error",
        "no gateway",
      );
    }
    // The grant is checked again, not remembered: it may have been taken away while this waited.
    const may = await this.deps.connections.mayUse({
      connection,
      subjectType: "bot",
      subjectId: call.botId,
      invokedBy: call.requestedBy,
    });
    if (!may.ok) {
      return await answered(`Not doing ${call.tool}: ${may.reason}`, "error", may.reason);
    }
    try {
      const result = await this.deps.mcp.call({
        connection,
        allowList: may.allowedTools,
        tool: call.tool,
        args: call.args,
        by: input.by,
        callerId: call.botId,
      });
      return await answered(wrapResult(connection.provider, call.tool, result), "done");
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      return await answered(`${call.tool} failed: ${said}`, "error", said);
    }
  }

  /** The card's answer, which arrives on the Bot API seam like every other block's (task 2.5). */
  private async decided(payload: InteractionReceived): Promise<void> {
    const callId = payload.block_id.startsWith(`${TOOL_CALL_ACTION}:`)
      ? payload.block_id.slice(TOOL_CALL_ACTION.length + 1)
      : "";
    const decision = payload.values.decision === "denied" ? "denied" : "approved";
    if (!callId || payload.user.type !== "user") return;
    await this.decideToolCall({
      callId,
      decision,
      userId: payload.user.id,
      by: { actor: { type: "user", id: payload.user.id }, meta: {} },
    });
  }

  /**
   * A provider said something happened, and a bot may have been waiting for it (spec §3.5, §5.3's
   * `webhook` trigger; task 3.4). The card the webhook posted is the message the run answers in,
   * so the bot's reply lands in the thread under it rather than loose in the channel.
   */
  async onWebhook(input: {
    workspaceId: string;
    channelId: string;
    provider: string;
    event: string | null;
    messageId: string;
    payload: Record<string, unknown>;
    by: ActorContext;
  }): Promise<void> {
    const channel = await getChannel(this.deps.db, input.channelId);
    if (!channel || channel.archivedAt) return;
    const message = await getMessage(this.deps.db, input.messageId);
    if (!message) return;
    await this.offer(
      channel,
      {
        kind: "webhook",
        channelId: channel.id,
        provider: input.provider,
        event: input.event,
      },
      message,
    );
  }

  /**
   * Every bot in the channel is offered what happened; the ones whose triggers fire answer — unless
   * the thread's rails say otherwise (spec §5.4). A person's word always gets through; a bot's is a
   * hop, and hops are counted, paired and paid for.
   */
  private async offer(channel: Channel, event: TriggerEvent, message: Message): Promise<void> {
    const threadRootId = message.threadRootId ?? message.id;
    if (await this.command(message, threadRootId)) return;
    if (await this.stopped(threadRootId)) return;
    const installed = await botsInChannel(this.deps.db, channel.id);
    for (const { bot, install } of installed) {
      if (bot.status !== "active") continue;
      if (!inScope(bot.spec, { id: channel.id, name: channel.name })) continue;
      const fired = firesOn({ id: bot.id, handle: bot.handle, spec: bot.spec }, event);
      if (!fired) continue;

      const from = {
        fromType: message.authorType,
        fromId: message.authorId,
        toBotId: bot.id,
      } as const;
      const state = await this.chainState(threadRootId, bot, channel);
      const verdict = mayHop(state, from);
      if (!verdict.ok) {
        // A chain that has gone as far as it may stops for everybody, and says so once.
        if (verdict.kind !== "self") await this.trip(channel, message, verdict.reason, bot);
        continue;
      }
      const chain = await startHop(this.deps.db, {
        workspaceId: channel.workspaceId,
        rootMessageId: threadRootId,
        threadRootId,
        hop: verdict.hop,
        fromType: message.authorType,
        fromId: message.authorId,
        toBotId: bot.id,
        mode: this.modes.get(message.id) ?? "consult",
        status: "running",
      });
      await this.deps.bus.publish(
        "bot.chain_hop",
        {
          workspaceId: channel.workspaceId,
          chainId: chain.id,
          threadRootId,
          hop: verdict.hop,
          fromType: message.authorType === "system" ? "user" : message.authorType,
          fromId: message.authorId,
          toBotId: bot.id,
          mode: "consult",
        },
        botActor(bot.id),
      );
      await this.run({
        bot,
        channel,
        trigger: fired.on,
        triggerRef: message.id,
        message,
        install,
        chain,
        by: botActor(bot.id),
      });
    }
  }

  /**
   * Somebody pressed Continue or Stop on the intervene card (spec §5.4). Continue lets the thread
   * carry on from where it stopped; Stop leaves it as it is, which is what it already was.
   */
  private async intervened(blockId: string, decision: string): Promise<void> {
    const threadRootId = blockId.startsWith(`${INTERVENE_ACTION}:`)
      ? blockId.slice(INTERVENE_ACTION.length + 1)
      : "";
    if (!threadRootId || decision !== "approved") return;
    const facts = await threadFactsOf(this.deps.db, threadRootId);
    const was = typeof facts[BREAKER] === "string" ? facts[BREAKER] : "";
    const values: Record<string, ThreadFactValue> = { [STOPPED]: false, [BREAKER]: "" };
    // Carrying on after the money ran out means another go at it, not the same refusal again.
    if (was.includes("budget")) {
      const hops = await chainOf(this.deps.db, threadRootId);
      const starter = hops[0] ? await getBot(this.deps.db, hops[0].toBotId) : null;
      const spentSoFar = hops.reduce((total, hop) => total + Number(hop.costUsd), 0);
      values[ALLOWANCE] =
        Math.round((spentSoFar + (starter?.budget.perThreadUsd ?? 0)) * 1e6) / 1e6;
    }
    await upsertThreadFacts(this.deps.db, threadRootId, values, {
      type: "user",
      id: (await getMessage(this.deps.db, threadRootId))?.authorId ?? threadRootId,
    });
  }

  /**
   * `/stop` halts every bot in a thread and `/resume` lets them go on (spec §5.4). A person says it
   * like anything else: the message stands as the record of who called it.
   */
  private async command(message: Message, threadRootId: string): Promise<boolean> {
    if (message.authorType !== "user") return false;
    const said = textOf(message.blocks).trim().toLowerCase();
    if (said !== "/stop" && said !== "/resume") return false;
    await upsertThreadFacts(
      this.deps.db,
      threadRootId,
      { [STOPPED]: said === "/stop", [BREAKER]: "" },
      { type: "user", id: message.authorId },
    );
    return true;
  }

  /** What a bot said, offered to the other bots in the room: the tag that makes a chain. */
  private async offerReply(
    channel: Channel,
    message: Message,
    bot: Bot,
    text: string,
  ): Promise<void> {
    const mentions = mentionsIn(text);
    if (mentions.length === 0) return;
    await this.offer(
      channel,
      {
        kind: "message",
        channelId: channel.id,
        channelType: channel.type,
        text,
        mentions,
        authorType: "bot",
        authorId: bot.id,
      },
      message,
    );
  }

  /**
   * Waiting for the bots that were tagged (spec §5.4 "orchestrator collects (wait_for_replies)").
   * A placeholder is not an answer, and neither is a message from before the wait began.
   */
  private async replies(
    bot: Bot,
    channel: Channel,
    threadRootId: string | null,
    input: {
      handles: string[];
      wait: "all" | "first" | "quorum";
      quorum?: number;
      timeoutMs?: number;
    },
  ): Promise<BotReply[]> {
    if (!threadRootId) return [];
    const wanted = input.handles.map((one) => one.replace(/^@/, "").toLowerCase());
    const who = await botsByHandles(this.deps.db, channel.workspaceId, wanted);
    if (who.length === 0) return [];
    const need =
      input.wait === "first"
        ? 1
        : input.wait === "quorum"
          ? Math.min(input.quorum ?? 1, who.length)
          : who.length;
    const deadline = Date.now() + Math.min(input.timeoutMs ?? WAIT_MS, WAIT_MS);
    const since = new Date();
    const seen = new Map<string, BotReply>();
    while (Date.now() < deadline && seen.size < need) {
      const rows = await listMessages(this.deps.db, channel.id, bot.ownerId, {
        threadRootId,
        limit: 100,
      });
      for (const row of rows) {
        if (row.authorType !== "bot" || row.createdAt < since) continue;
        const author = who.find((one) => one.id === row.authorId);
        const text = textOf(row.blocks).trim();
        if (!author || text === "" || text === PLACEHOLDER) continue;
        seen.set(author.handle, { handle: author.handle, text, at: row.createdAt.toISOString() });
      }
      if (seen.size >= need) break;
      await Bun.sleep(WAIT_POLL_MS);
    }
    return [...seen.values()];
  }

  /** A card the bot posted, rewritten in place: the same edit a streaming reply makes. */
  private async rewriteBlocks(
    bot: Bot,
    channel: Channel,
    message: Message,
    blocks: MessageBlock[],
  ): Promise<void> {
    await updateMessageBlocks(this.deps.db, message, blocks, {
      type: "bot",
      id: bot.id,
      history: false,
    });
    await this.deps.bus.publish(
      "message.updated",
      { workspaceId: channel.workspaceId, channelId: channel.id, messageId: message.id },
      botActor(bot.id),
    );
  }

  /**
   * One job, split (spec §5.4 "fan-out (parallel; wait for all/first/quorum)"; task 3.10).
   *
   * Three things happen here that tagging one bot at a time cannot do. The thread gets a **plan
   * card** — who was asked what, rewritten in place as answers land, so a person scrolling past
   * sees the shape of the work instead of five loose messages. The root's remaining budget is
   * **split**, so the first specialist to run cannot spend what the other two were promised. And
   * the orchestrator gets everything back at once, to fold into one answer.
   *
   * Nothing here is inherited: every specialist still runs on its own brain, its own tools and its
   * own grants (spec §5.4). A share is a ceiling, not a credential.
   */
  private async fanOut(
    bot: Bot,
    channel: Channel,
    threadRootId: string | null,
    input: {
      tasks: { handle: string; text: string }[];
      wait: "all" | "first" | "quorum";
      quorum?: number;
      timeoutMs?: number;
    },
  ): Promise<{ replies: BotReply[]; refused: { handle: string; reason: string }[] }> {
    if (!threadRootId) {
      return { replies: [], refused: [{ handle: "", reason: "there is no thread to fan out in" }] };
    }
    // Fanning out is the orchestrator flag's whole job (spec §5.3 "orchestrator flag").
    if (!bot.orchestrator) {
      return {
        replies: [],
        refused: [{ handle: "", reason: "only an orchestrator may split a job across bots" }],
      };
    }
    const rails = await this.deps.policy.evaluate(
      { workspaceId: channel.workspaceId },
      { kind: "bot.mention", ...(channel.name ? { channel: channel.name } : {}) },
    );
    if (!rails.allow) {
      return { replies: [], refused: [{ handle: "", reason: rails.reason ?? "not here" }] };
    }

    const wanted = input.tasks.map((task) => ({
      ...task,
      handle: task.handle.replace(/^@/, "").toLowerCase(),
    }));
    const known = await botsByHandles(
      this.deps.db,
      channel.workspaceId,
      wanted.map((one) => one.handle),
    );
    const state = await this.chainState(threadRootId, bot, channel);
    // What is left of the thread's money, divided evenly among the ones actually tagged. Uncapped
    // stays uncapped: a thread with no budget does not gain one by being split.
    const left = state.budgetUsd === null ? null : Math.max(state.budgetUsd - spent(state), 0);

    const refused: { handle: string; reason: string }[] = [];
    const going: { handle: string; text: string; botId: string }[] = [];
    for (const task of wanted) {
      const tagged = known.find((one) => one.handle === task.handle);
      if (!tagged) {
        refused.push({ handle: task.handle, reason: `there is no @${task.handle} here` });
        continue;
      }
      const verdict = mayHop(state, { fromType: "bot", fromId: bot.id, toBotId: tagged.id });
      if (!verdict.ok) {
        refused.push({ handle: task.handle, reason: verdict.reason });
        continue;
      }
      going.push({ handle: tagged.handle, text: task.text, botId: tagged.id });
    }
    if (going.length === 0) return { replies: [], refused };

    const share = left === null ? null : Math.round((left / going.length) * 1e6) / 1e6;
    if (share !== null) {
      const shares: Record<string, ThreadFactValue> = {};
      for (const one of going) shares[one.botId] = share;
      await upsertThreadFacts(
        this.deps.db,
        threadRootId,
        { [SHARES]: shares },
        { type: "bot", id: bot.id },
      );
    }

    // The plan, before any of it has happened.
    const steps = going.map((one) => ({
      handle: one.handle,
      text: one.text,
      status: "waiting" as const,
      ...(share === null ? {} : { budgetUsd: share }),
    }));
    const card = await this.post(channel, threadRootId, bot, [
      { type: "plan_card", text: `${bot.name} split this ${going.length} ways`, steps },
    ]);

    // Then the tags themselves, each the same path a person's mention takes.
    for (const one of going) {
      const posted = await this.post(channel, threadRootId, bot, [
        { type: "text", text: `<@${one.handle}> ${one.text}` },
      ]);
      this.rememberMode(posted.id, "fanout");
    }

    const replies = await this.replies(bot, channel, threadRootId, {
      handles: going.map((one) => one.handle),
      wait: input.wait,
      ...(input.quorum === undefined ? {} : { quorum: input.quorum }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

    // And the card again, with what came back.
    const answered = new Map(replies.map((reply) => [reply.handle, reply]));
    await this.rewriteBlocks(bot, channel, card, [
      {
        type: "plan_card",
        text: `${bot.name} split this ${going.length} ways`,
        steps: steps.map((step) => {
          const said = answered.get(step.handle);
          return {
            ...step,
            status: said ? ("done" as const) : ("failed" as const),
            ...(said ? { note: said.text.slice(0, 500) } : { note: "no answer in time" }),
          };
        }),
      },
    ]);
    return { replies, refused };
  }

  /** The thread as the rails see it: its hops, and what the bot that started it allowed. */
  /**
   * How a bot meant a tag it made (spec §5.4). Read by every bot the message offers itself to — the
   * native runtime and the Bot API alike — so it is kept rather than taken, and the oldest go first.
   */
  private rememberMode(messageId: string, mode: ChainMode): void {
    this.modes.set(messageId, mode);
    while (this.modes.size > MODES_KEPT) {
      const oldest = this.modes.keys().next().value;
      if (oldest === undefined) break;
      this.modes.delete(oldest);
    }
  }

  /**
   * The rails for a bot that is told about a mention over the Bot API (spec §5.4, §7.3
   * `app_mention`): the chain state `offer()` holds a native bot to, so an outside bot hears which
   * hop this is, how the tag was meant, and what is left of the thread's budget — and is not told
   * at all when the rails say the hop may not happen.
   *
   * A bot the native runtime answers here has its hop recorded by `offer()`. Any other bot's hop is
   * recorded here, at no cost Perch can see, so a chain through outside bots meets the same hop
   * limit, repeat-pair breaker and budget as one through native bots.
   */
  async mentionRails(input: {
    channel: Channel;
    message: Message;
    bot: Bot;
  }): Promise<MentionRails> {
    const { channel, message, bot } = input;
    const threadRootId = message.threadRootId ?? message.id;
    if (await this.stopped(threadRootId)) {
      return { ok: false, reason: "this thread has been stopped" };
    }
    const from = {
      fromType: message.authorType,
      fromId: message.authorId,
      toBotId: bot.id,
    } as const;
    const text = textOf(message.blocks);
    const native =
      bot.status === "active" &&
      inScope(bot.spec, { id: channel.id, name: channel.name }) &&
      firesOn(
        { id: bot.id, handle: bot.handle, spec: bot.spec },
        {
          kind: "message",
          channelId: channel.id,
          channelType: channel.type,
          text,
          mentions: mentionsIn(text),
          authorType: message.authorType,
          authorId: message.authorId,
        },
      ) !== null;
    const state = await this.chainState(threadRootId, bot, channel);
    const verdict = mayHop(state, from);
    if (!verdict.ok) {
      // The native path trips the breaker for its own bots; this one does for the rest.
      if (!native && verdict.kind !== "self")
        await this.trip(channel, message, verdict.reason, bot);
      return { ok: false, reason: verdict.reason };
    }
    // A person's tag has no mode; a bot's is what it said it meant, and a consult otherwise.
    const mode = message.authorType === "bot" ? (this.modes.get(message.id) ?? "consult") : null;
    if (!native) {
      const chain = await startHop(this.deps.db, {
        workspaceId: channel.workspaceId,
        rootMessageId: threadRootId,
        threadRootId,
        hop: verdict.hop,
        fromType: message.authorType,
        fromId: message.authorId,
        toBotId: bot.id,
        mode: mode ?? "consult",
        status: "running",
      });
      // What an outside bot spends, it spends outside: the hop is counted, its cost is not known.
      await finishHop(this.deps.db, chain.id, { status: "done", tokens: 0, costUsd: 0 });
      await this.deps.bus.publish(
        "bot.chain_hop",
        {
          workspaceId: channel.workspaceId,
          chainId: chain.id,
          threadRootId,
          hop: verdict.hop,
          fromType: message.authorType === "system" ? "user" : message.authorType,
          fromId: message.authorId,
          toBotId: bot.id,
          mode: mode ?? "consult",
        },
        botActor(bot.id),
      );
    }
    return { ok: true, hop: verdict.hop, mode, budgetRemaining: verdict.leftUsd };
  }

  private async chainState(
    threadRootId: string,
    bot: Bot,
    channel?: Channel | undefined,
  ): Promise<ChainState> {
    const hops = await chainOf(this.deps.db, threadRootId);
    const first = hops[0];
    const starter = first ? await getBot(this.deps.db, first.toBotId) : bot;
    const budget = (starter ?? bot).budget;
    // A person who pressed Continue after the money ran out has said what the thread may spend.
    const facts = await threadFactsOf(this.deps.db, threadRootId);
    const allowed = typeof facts[ALLOWANCE] === "number" ? facts[ALLOWANCE] : null;
    // The workspace's rails narrow a bot's own, never widen them (spec §5.7; task 2.11).
    const policy = channel
      ? await this.deps.policy.policyFor({ workspaceId: channel.workspaceId })
      : undefined;
    const rails = [budget.maxHops ?? DEFAULT_MAX_HOPS, policy?.bots?.maxHops].filter(
      (one): one is number => typeof one === "number",
    );
    // What a fan-out promised each specialist, when one has happened here (task 3.10).
    const shares = shareTable(facts[SHARES]);
    const ceiling = policy?.budgets?.perThreadUsd;
    const thread = [allowed ?? budget.perThreadUsd, ceiling].filter(
      (one): one is number => typeof one === "number",
    );
    return {
      hops: hops.map((hop) => ({
        fromType: hop.fromType,
        fromId: hop.fromId,
        toBotId: hop.toBotId,
        mode: hop.mode,
        costUsd: Number(hop.costUsd),
      })),
      budgetUsd: thread.length > 0 ? Math.min(...thread) : null,
      maxHops: Math.min(...rails),
      ...(shares ? { shares } : {}),
    };
  }

  /** Whether this thread has been halted, by a person or by the breaker. */
  private async stopped(threadRootId: string): Promise<boolean> {
    const facts = await threadFactsOf(this.deps.db, threadRootId);
    return facts[STOPPED] === true;
  }

  /**
   * The breaker (spec §5.4): the thread pauses, and a card asks somebody to decide. Continue clears
   * it; Stop leaves it stopped. It is said once — a second trip in a stopped thread is silent.
   */
  private async trip(channel: Channel, message: Message, reason: string, bot: Bot): Promise<void> {
    const threadRootId = message.threadRootId ?? message.id;
    if (await this.stopped(threadRootId)) return;
    await upsertThreadFacts(
      this.deps.db,
      threadRootId,
      { [STOPPED]: true, [BREAKER]: reason },
      { type: "bot", id: bot.id },
    );
    const hops = await chainOf(this.deps.db, threadRootId);
    const summary = summarize(
      {
        hops: hops.map((hop) => ({
          fromType: hop.fromType,
          fromId: hop.fromId,
          toBotId: hop.toBotId,
          mode: hop.mode,
          costUsd: Number(hop.costUsd),
        })),
        budgetUsd: null,
      },
      reason,
    );
    await this.deps.bus.publish(
      "bot.chain_breaker",
      {
        workspaceId: channel.workspaceId,
        chainId: hops.at(-1)?.id ?? threadRootId,
        threadRootId,
        reason,
      },
      botActor(bot.id),
    );
    // The card is the ordinary interactive block (task 2.5), so it works everywhere already.
    await this.card(channel, message, bot, reason, summary.hops, summary.costUsd);
  }

  private async card(
    channel: Channel,
    message: Message,
    bot: Bot,
    reason: string,
    hops: number,
    costUsd: number,
  ): Promise<void> {
    const threadRootId = message.threadRootId ?? message.id;
    const spentSoFar = costUsd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    await this.post(channel, threadRootId, bot, [
      {
        type: "text",
        text: `The bots here have been paused: ${reason}. ${hops} hops so far, about $${spentSoFar}.`,
      },
      {
        type: "approve_deny",
        id: `${INTERVENE_ACTION}:${threadRootId}`,
        text: "Let them carry on?",
        action: INTERVENE_ACTION,
      },
    ]);
  }

  /**
   * A new bot. The handle is what people type after an `@`, so it is normalized the way a person's
   * is and refused when it is already somebody's.
   */
  async create(input: {
    workspaceId: string;
    ownerId: string;
    handle: string;
    name: string;
    spec?: BotSpec;
    visibility?: Bot["visibility"];
    budget?: Bot["budget"];
    orchestrator?: boolean;
    /** How it was made (spec §6 bots.level): `ui` unless it joins over the Bot API (task 3.9). */
    level?: Bot["level"];
    by: ActorContext;
  }): Promise<Bot> {
    const handle = normalizeHandle(input.handle);
    if (input.spec) checkTriggers(input.spec);
    if (await botByHandle(this.deps.db, input.workspaceId, handle)) {
      throw PerchError.conflict("that handle is taken");
    }
    // Somebody in this workspace, rather than somebody anywhere: `@dawn` means whoever is called
    // that here.
    if (await handleTaken(this.deps.db, handle, input.workspaceId)) {
      throw PerchError.conflict("that handle belongs to somebody");
    }
    const bot = await insertBot(this.deps.db, {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      handle,
      name: input.name,
      level: input.level ?? "ui",
      ...(input.spec ? { spec: input.spec } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.orchestrator === undefined ? {} : { orchestrator: input.orchestrator }),
    });
    await this.reschedule(bot);
    return bot;
  }

  async update(
    bot: Bot,
    values: Partial<
      Pick<Bot, "name" | "spec" | "visibility" | "status" | "budget" | "orchestrator">
    >,
  ): Promise<Bot> {
    if (values.spec !== undefined) checkTriggers(values.spec);
    const updated = await updateBot(this.deps.db, bot.id, values);
    if (!updated) throw PerchError.notFound("bot");
    if (values.spec !== undefined || values.status !== undefined) await this.reschedule(updated);
    return updated;
  }

  async remove(bot: Bot): Promise<void> {
    await this.reschedule({ ...bot, status: "disabled" });
    await deleteBot(this.deps.db, bot.id);
  }

  /** Putting a bot in a channel makes it a member of it: it reads and writes as itself. */
  async install(bot: Bot, channel: Channel, by: ActorContext): Promise<void> {
    if (channel.workspaceId !== bot.workspaceId) throw PerchError.notFound("channel");
    if (channel.archivedAt) throw PerchError.conflict("this channel is archived");
    await installBot(this.deps.db, { botId: bot.id, channelId: channel.id });
    await this.deps.bus.publish(
      "bot.installed",
      { workspaceId: channel.workspaceId, botId: bot.id, channelId: channel.id },
      by,
    );
    // The member list changed, which is what makes every open channel header redraw.
    await this.deps.bus.publish(
      "channel.updated",
      { workspaceId: channel.workspaceId, channelId: channel.id, changes: ["members"] },
      by,
    );
    // Arriving is something a bot can answer to (spec §5.3 "channel join").
    const fired = firesOn(
      { id: bot.id, handle: bot.handle, spec: bot.spec },
      { kind: "channel_join", channelId: channel.id, botId: bot.id },
    );
    if (fired && bot.status === "active") {
      this.track(
        this.run({
          bot,
          channel,
          trigger: "channel_join",
          triggerRef: channel.id,
          by: botActor(bot.id),
        }),
      );
    }
  }

  /**
   * The room one person shares with one bot (spec §5.2 "DM-a-bot"). There is one per pair, made the
   * first time it is opened: the bot is in it as a member, and nobody else can see it. Every chat
   * in it is a thread, so "New chat" is a new root message and nothing else.
   */
  async dm(bot: Bot, userId: string, by: ActorContext): Promise<Channel> {
    const found = await findBotDm(this.deps.db, bot.workspaceId, userId, bot.id);
    if (found) return found;
    const channel = await insertChannel(this.deps.db, {
      workspaceId: bot.workspaceId,
      type: "dm",
      name: null,
      topic: null,
    });
    await addMember(this.deps.db, {
      channelId: channel.id,
      memberType: "user",
      memberId: userId,
      role: "owner",
    });
    await this.deps.bus.publish(
      "channel.created",
      { workspaceId: channel.workspaceId, channelId: channel.id, type: channel.type },
      by,
    );
    await this.install(bot, channel, by);
    return channel;
  }

  /**
   * Which brain this bot runs on in one room (spec §5.2 "model picker per DM when the bot allows").
   * A bot that does not allow it keeps the brain its maker gave it; `null` puts it back.
   */
  async pickBrain(
    bot: Bot,
    channel: Channel,
    profile: string | null,
    by: ActorContext,
  ): Promise<BotInstall> {
    if (!bot.spec.brain?.pick) {
      throw PerchError.conflict("this bot's brain is not yours to choose");
    }
    const install = await findInstall(this.deps.db, bot.id, channel.id);
    if (!install) throw PerchError.notFound("bot");
    if (profile) {
      const profiles = await this.deps.brains.profiles(bot.workspaceId);
      if (!profiles.some((row) => row.name === profile)) {
        throw PerchError.validation(`there is no brain called ${profile}`);
      }
    }
    const { brain: _was, ...rest } = install.scopes;
    const scopes = profile ? { ...rest, brain: profile } : rest;
    const saved = await installBot(this.deps.db, {
      botId: bot.id,
      channelId: channel.id,
      scopes,
    });
    // The room's header says which brain it is on, so everybody watching it looks again.
    await this.deps.bus.publish(
      "channel.updated",
      { workspaceId: channel.workspaceId, channelId: channel.id, changes: ["members"] },
      by,
    );
    return saved;
  }

  async uninstall(bot: Bot, channel: Channel, by: ActorContext): Promise<boolean> {
    const gone = await uninstallBot(this.deps.db, bot.id, channel.id);
    if (gone) {
      await this.deps.bus.publish(
        "bot.uninstalled",
        { workspaceId: channel.workspaceId, botId: bot.id, channelId: channel.id },
        by,
      );
      await this.deps.bus.publish(
        "channel.updated",
        { workspaceId: channel.workspaceId, channelId: channel.id, changes: ["members"] },
        by,
      );
    }
    return gone;
  }

  /**
   * The Forge's test chat (spec §5.3 "form + live test chat"; the UI is task 2.8). The same turn a
   * channel would get, with nowhere to post it: the answer comes back to whoever asked.
   */
  async test(bot: Bot, channel: Channel, prompt: string, by: ActorContext): Promise<RunOutcome> {
    return this.run({ bot, channel, trigger: "test", prompt, quiet: true, by });
  }

  /** One turn: the budget, the brain, the placeholder, the model, the reply, the ledger. */
  /**
   * One event through a code bot (spec §5.3; task 3.2). It runs in QuickJS with no host and a
   * ceiling: what it may do is the tools its spec allows, through the same registry a native bot
   * uses, so a code bot has no permission a form bot does not. A run that loops, throws or runs out
   * of memory is a failed `bot_runs` row and nothing more.
   */
  /**
   * An agent bot's turn (spec §5.3 "Agent bots: `engine: opencode|acp` + `projects: [...]` —
   * `@dawn add a dark-mode toggle` opens a session on that project"; task 3.7).
   *
   * What it says back is a session card, not an answer: the work happens in the session, and the
   * thread gets its permissions and its diff as they arrive (the agent-bots subscriber). The run
   * is over as soon as the session is open — the session keeps its own ledger from there.
   */
  private async runAgent(
    bot: Bot,
    channel: Channel,
    input: RunInput,
    run: BotRun,
  ): Promise<RunOutcome> {
    const asked =
      input.prompt ?? (input.message ? withoutMentions(textOf(input.message.blocks)) : "");
    const threadRootId = input.message?.threadRootId ?? input.message?.id ?? null;
    if (!this.deps.agents) {
      const said = "There is nothing here to open a session with.";
      if (!input.quiet) await this.say(bot, channel, input.message, said);
      const ended = await finishRun(this.deps.db, run.id, { status: "error", error: said });
      return { run: ended ?? run, text: said };
    }
    try {
      const opened = await this.deps.agents.open({
        bot,
        channel,
        threadRootId,
        projects: bot.spec.projects ?? [],
        engine: bot.spec.engine ?? "",
        prompt: asked,
      });
      const said = `Working on it in ${opened.project}.`;
      if (!input.quiet) {
        await this.post(channel, threadRootId, bot, [
          { type: "text", text: said },
          {
            type: "session_card",
            sessionId: opened.sessionId,
            text: opened.project,
            url: opened.url,
          },
        ]);
      }
      const ended = await finishRun(this.deps.db, run.id, { status: "done" });
      if (input.chain) {
        await finishHop(this.deps.db, input.chain.id, { status: "done", tokens: 0, costUsd: 0 });
      }
      return { run: ended ?? run, text: said };
    } catch (error) {
      const said = error instanceof PerchError ? error.message : "That session would not open.";
      if (!input.quiet) await this.say(bot, channel, input.message, said);
      this.deps.log.warn({ err: error, botId: bot.id }, "an agent bot could not open a session");
      const ended = await finishRun(this.deps.db, run.id, { status: "error", error: said });
      if (input.chain) {
        await finishHop(this.deps.db, input.chain.id, { status: "error", tokens: 0, costUsd: 0 });
      }
      await this.deps.bus.publish(
        "bot.run_failed",
        { workspaceId: channel.workspaceId, botId: bot.id, runId: run.id, error: said },
        input.by,
      );
      return { run: ended ?? run, text: said };
    }
  }

  private async runCode(
    bot: Bot,
    channel: Channel,
    input: RunInput,
    run: BotRun,
  ): Promise<RunOutcome> {
    const allowed = this.toolsAllowed(bot.spec, input.install ?? null);
    const set = toolsFor(allowed, this.hostFor(bot, channel, input));
    const tools: CodeBotTools = {};
    for (const [name, one] of Object.entries(set)) {
      const shaped = one as {
        inputSchema?: { parse: (value: unknown) => unknown };
        execute?: (args: unknown, options: unknown) => Promise<unknown>;
      };
      if (!shaped.execute) continue;
      // The run's signal goes through, so a tool still waiting when the run ends can stop.
      tools[name] = async (args, { signal }) => {
        const parsed = shaped.inputSchema ? shaped.inputSchema.parse(args ?? {}) : (args ?? {});
        return await shaped.execute?.(parsed, { abortSignal: signal });
      };
    }

    const event: CodeBotEvent = {
      kind:
        input.trigger === "schedule"
          ? "schedule"
          : input.trigger === "webhook"
            ? "webhook"
            : "message",
      payload: {
        text: input.prompt ?? (input.message ? textOf(input.message.blocks) : ""),
        channel: channel.id,
        channel_name: channel.name,
        thread_root_id: input.message?.threadRootId ?? input.message?.id ?? null,
        trigger: input.trigger,
      },
    };
    const result = await runCodeBot({ code: bot.code ?? "", event, tools });
    // A handler that returns a string has said something; one that posted for itself has not.
    const said = typeof result.returned === "string" ? result.returned.trim() : "";
    if (said && !input.quiet) await this.say(bot, channel, input.message, said);
    if (result.error && !input.quiet) {
      await this.say(bot, channel, input.message, `That did not run: ${result.error}`);
    }
    if (result.logs.length > 0) {
      this.deps.log.info({ botId: bot.id, runId: run.id, logs: result.logs }, "code bot");
    }
    const ended = await finishRun(this.deps.db, run.id, {
      status: result.error ? "error" : "done",
      ...(result.error ? { error: result.error.slice(0, 1000) } : {}),
    });
    if (input.chain) {
      await finishHop(this.deps.db, input.chain.id, {
        status: result.error ? "error" : "done",
        tokens: 0,
        costUsd: 0,
      });
    }
    await this.deps.bus.publish(
      result.error ? "bot.run_failed" : "bot.run_finished",
      result.error
        ? {
            workspaceId: channel.workspaceId,
            botId: bot.id,
            runId: run.id,
            error: result.error.slice(0, 500),
          }
        : { workspaceId: channel.workspaceId, botId: bot.id, runId: run.id, costUsd: 0 },
      input.by,
    );
    return { run: ended ?? run, text: said || (result.error ?? "") };
  }

  async run(input: RunInput): Promise<RunOutcome> {
    const { bot, channel } = input;
    const now = new Date();
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const hour = new Date(now.getTime() - 60 * 60 * 1000);
    const state = await spending(this.deps.db, bot.id, { day, hour });
    // A workspace's ceilings narrow a bot's own budget and never widen it (spec §5.7; task 2.11).
    const ceilings = (await this.deps.policy.policyFor({ workspaceId: channel.workspaceId }))
      .budgets;
    let verdict = withinBudget(capped(bot.budget, ceilings), state);
    // And the workspace's own ceilings, counted from the ledger rather than from this bot's runs
    // (task 4.2): a bot inside its own budget is still inside the workspace's.
    if (verdict.ok && this.deps.budgets) {
      const ledger = await this.deps.budgets.check(
        channel.workspaceId,
        [
          { type: "workspace" },
          { type: "bot", id: bot.id },
          ...(bot.ownerId ? [{ type: "user" as const, id: bot.ownerId }] : []),
        ],
        input.by,
      );
      if (!ledger.ok) verdict = { ok: false, reason: ledger.reason };
    }

    const run = await startRun(this.deps.db, {
      workspaceId: channel.workspaceId,
      botId: bot.id,
      trigger: input.trigger,
      ...(input.triggerRef ? { triggerRef: input.triggerRef } : {}),
      status: "running",
      engine: "native",
    });

    await this.deps.bus.publish(
      "bot.run_started",
      {
        workspaceId: channel.workspaceId,
        botId: bot.id,
        runId: run.id,
        trigger: input.trigger,
      },
      input.by,
    );

    if (!verdict.ok) {
      // A bot that cannot answer says so where it was asked: silence looks like a broken bot.
      if (!input.quiet) await this.say(bot, channel, input.message, verdict.reason);
      const ended = await finishRun(this.deps.db, run.id, {
        status: "refused",
        error: verdict.reason,
      });
      // Only a refusal about money is a budget event; a rate limit is not one (spec §7.7).
      if (bot.budget.dailyUsd !== undefined && state.spentTodayUsd >= bot.budget.dailyUsd) {
        await this.deps.bus.publish(
          "budget.exceeded",
          {
            workspaceId: channel.workspaceId,
            subjectType: "bot",
            subjectId: bot.id,
            spentUsd: state.spentTodayUsd,
            limitUsd: bot.budget.dailyUsd,
          },
          input.by,
        );
      }
      return { run: ended ?? run, text: verdict.reason };
    }

    // One trace per bot run (task 3.22), whichever lane answers it. Active for the length of the
    // run, so the model call and every tool it reaches for land inside it.
    return await tracer().startActiveSpan(
      "bot.run",
      {
        attributes: {
          "perch.trigger": input.trigger,
          ...ids({ workspaceId: channel.workspaceId, botId: bot.id }),
        },
      },
      async (traced) => {
        try {
          return await this.answered(bot, channel, input, run, state, traced);
        } finally {
          traced.end();
        }
      },
    );
  }

  /** The run itself, inside its span. */
  private async answered(
    bot: Bot,
    channel: Channel,
    input: RunInput,
    run: BotRun,
    state: Awaited<ReturnType<typeof spending>>,
    traced: Span,
  ): Promise<RunOutcome> {
    // A code bot is its own answer: the file decides, not a model (spec §5.3; task 3.2).
    if (bot.code) return await this.runCode(bot, channel, input, run);
    // An agent bot does not answer from a model at all: it opens a session (spec §5.3; task 3.7).
    if (bot.spec.engine) return await this.runAgent(bot, channel, input, run);

    let placeholder: Message | null = null;
    try {
      const profile = await this.brainFor(bot, input.install ?? null);
      // What this room allows (spec §5.7 "this channel: local models only"; task 2.11).
      const onTheList = await this.deps.policy.check(
        { workspaceId: channel.workspaceId, subject: { type: "bot", id: bot.id } },
        {
          kind: "model",
          ref: `${profile.provider}/${profile.modelId}`,
          profile: profile.name,
          ...(channel.name ? { channel: channel.name } : {}),
        },
        input.by,
      );
      if (!onTheList.allow) throw new PerchError("policy_violation", onTheList.reason);
      const model = await this.deps.brains.languageModel(profile, bot.ownerId);
      const messages = await this.conversation(bot, channel, input);
      const allowed = this.toolsAllowed(bot.spec, input.install ?? null);
      // Native tools, plus anything an attached MCP server contributes (spec §5.3; task 3.6).
      const tools = {
        ...toolsFor(allowed, this.hostFor(bot, channel, input)),
        ...(await this.attachedTools(bot, channel, input, traced)),
      };
      placeholder = input.quiet ? null : await this.say(bot, channel, input.message, PLACEHOLDER);

      const stopper = new AbortController();
      this.stopping.set(run.id, stopper);
      const result = await spanUnder(
        traced,
        "bot.model",
        {
          "perch.model_id": profile.modelId,
          "perch.provider": profile.provider,
          ...ids({ workspaceId: channel.workspaceId, botId: bot.id }),
        },
        async () =>
          await runBot({
            signal: stopper.signal,
            bot: { id: bot.id, name: bot.name, handle: bot.handle, spec: bot.spec },
            model,
            modelId: profile.modelId,
            messages,
            tools,
            allowed,
            capUsd: budgetLeft(bot.budget, state),
            ...(this.options.editEveryMs === undefined
              ? {}
              : { editEveryMs: this.options.editEveryMs }),
            placeholder: {
              update: async (text) => {
                if (placeholder) placeholder = await this.rewrite(bot, channel, placeholder, text);
              },
              finish: async (text) => {
                if (placeholder) placeholder = await this.rewrite(bot, channel, placeholder, text);
              },
            },
          }),
      );

      // The answer is already in the message; only a note about an overrun needs another write.
      const said = withNote(result.text, result.stopped);
      if (placeholder && result.stopped) {
        placeholder = await this.rewrite(bot, channel, placeholder, said);
      }
      traced.setAttributes({
        "perch.input_tokens": result.inputTokens,
        "perch.output_tokens": result.outputTokens,
        "perch.cost_usd": result.costUsd,
        "perch.model_id": profile.modelId,
      });
      const ended = await finishRun(this.deps.db, run.id, {
        status: "done",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        modelId: profile.modelId,
      });
      // The same ledger the gateway writes: what a workspace spent is one query, whoever spent it
      // (task 4.2).
      await this.deps.usage?.record({
        workspaceId: channel.workspaceId,
        actorType: "bot",
        actorId: bot.id,
        botRunId: run.id,
        provider: profile.provider,
        modelId: profile.modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        by: input.by,
      });
      if (input.chain) {
        await finishHop(this.deps.db, input.chain.id, {
          status: "done",
          tokens: result.inputTokens + result.outputTokens,
          costUsd: result.costUsd,
        });
      }
      await this.deps.bus.publish(
        "bot.run_finished",
        {
          workspaceId: channel.workspaceId,
          botId: bot.id,
          runId: run.id,
          costUsd: result.costUsd,
        },
        input.by,
      );
      // A reply arrives by editing the placeholder, so the bus never carries its words. What one
      // bot says to another is offered here instead — once, when it is finished (spec §5.4).
      if (placeholder) await this.offerReply(channel, placeholder, bot, said);
      return { run: ended ?? run, text: said };
    } catch (error) {
      // A run somebody stopped is not a run that broke, and the row should say which it was.
      const why = this.stopping.get(run.id)?.signal.aborted
        ? "stopped by a person"
        : error instanceof PerchError
          ? error.message
          : "this bot could not answer";
      this.deps.log.error({ err: error, botId: bot.id }, "bot run failed");
      if (placeholder) await this.rewrite(bot, channel, placeholder, why);
      else if (!input.quiet) await this.say(bot, channel, input.message, why);
      const ended = await finishRun(this.deps.db, run.id, { status: "error", error: why });
      if (input.chain) {
        await finishHop(this.deps.db, input.chain.id, { status: "error", breakerReason: why });
      }
      await this.deps.bus.publish(
        "bot.run_failed",
        { workspaceId: channel.workspaceId, botId: bot.id, runId: run.id, error: why },
        input.by,
      );
      return { run: ended ?? run, text: why };
    } finally {
      this.stopping.delete(run.id);
    }
  }

  /**
   * The brain this run uses: the one the room picked when the bot allows it to be picked (spec §5.2
   * "model picker per DM when the bot allows"), else the one the spec names, else the workspace's
   * default for chat.
   */
  private async brainFor(bot: Bot, install?: BotInstall | null) {
    const picked = bot.spec.brain?.pick ? install?.scopes.brain : undefined;
    const wanted = picked ?? bot.spec.brain?.profile;
    const profiles = await this.deps.brains.profiles(bot.workspaceId);
    const profile = wanted
      ? profiles.find((row) => row.name === wanted)
      : (profiles.find((row) => row.defaultFor === "chat") ?? profiles[0]);
    if (!profile) {
      throw PerchError.validation(
        wanted ? `this bot's brain (${wanted}) is not here` : "this workspace has no brain yet",
      );
    }
    return profile;
  }

  /** The tools this bot may use here: its spec, narrowed by where it has been installed. */
  private toolsAllowed(spec: BotSpec, install: BotInstall | null): BotTool[] {
    const wanted = spec.tools ?? [];
    const narrowed = install?.scopes.tools;
    return narrowed ? wanted.filter((tool) => narrowed.includes(tool)) : [...wanted];
  }

  /**
   * What the bot is shown, oldest first, in the model's own shape: the conversation it is in. Asked
   * in a thread, that is the thread — its root and the replies under it. Asked in a room, it is the
   * room's recent flow. A chat with a bot is a thread of its own, so "New chat" starts the bot on
   * nothing but what is said in the new one (spec §5.2 "New chat starts a fresh thread"; task 2.9).
   */
  private async conversation(bot: Bot, channel: Channel, input: RunInput): Promise<ModelMessage[]> {
    if (input.prompt && !input.message) {
      return [{ role: "user", content: input.prompt }];
    }
    const window = bot.spec.memory?.window ?? DEFAULT_WINDOW;
    const asked = input.message;
    const alone = channel.type === "dm" || channel.type === "group";
    const rootId = asked && (alone || asked.threadRootId) ? (asked.threadRootId ?? asked.id) : null;
    const rows = rootId
      ? await this.chat(channel, rootId, bot.ownerId, window)
      : await listMessages(this.deps.db, channel.id, bot.ownerId, { limit: window });
    const seen = rows.some((row) => row.id === input.message?.id);
    const all = seen || !input.message ? rows : [...rows, { ...input.message, authorName: null }];
    const messages: ModelMessage[] = [];
    for (const row of all) {
      const text = textOf(row.blocks);
      if (!text.trim()) continue;
      if (row.authorType === "bot" && row.authorId === bot.id) {
        messages.push({ role: "assistant", content: text });
        continue;
      }
      const who = "authorName" in row && row.authorName ? row.authorName : "Someone";
      messages.push({ role: "user", content: `${who}: ${text}` });
    }
    if (messages.length === 0) messages.push({ role: "user", content: input.prompt ?? "hello" });
    return messages;
  }

  /** A message from the bot, in the thread it was asked in (spec §5.4 "always reply in-thread"). */
  private async say(
    bot: Bot,
    channel: Channel,
    asked: Message | undefined,
    text: string,
  ): Promise<Message> {
    // A room keeps the answer in a thread, and so does a chat with a bot: each chat is one, which
    // is what lets "New chat" start the bot on a clean context (spec §5.2; task 2.9).
    const threadRootId = asked ? (asked.threadRootId ?? asked.id) : null;
    return this.post(channel, threadRootId, bot, [{ type: "text", text }]);
  }

  /** One chat, oldest first: the message that started it and everything hanging off it. */
  private async chat(
    channel: Channel,
    rootId: string,
    readerId: string,
    limit: number,
  ): Promise<MessageRow[]> {
    const root = await getMessageRow(this.deps.db, rootId, readerId);
    const replies = await listMessages(this.deps.db, channel.id, readerId, {
      threadRootId: rootId,
      limit,
    });
    return [...(root ? [root] : []), ...replies];
  }

  /** Whatever the bot has to say, as blocks, where it was asked. */
  private async post(
    channel: Channel,
    threadRootId: string | null,
    bot: Bot,
    blocks: MessageBlock[],
  ): Promise<Message> {
    const message = await insertMessage(this.deps.db, {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      threadRootId,
      authorType: "bot",
      authorId: bot.id,
      blocks,
    });
    await this.deps.bus.publish(
      "message.created",
      {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        messageId: message.id,
        ...(threadRootId ? { threadRootId } : {}),
        authorType: "bot" as const,
        authorId: bot.id,
      },
      botActor(bot.id),
    );
    return message;
  }

  /** The placeholder, rewritten as the answer arrives. Not an edit: nobody rewrote anything. */
  private async rewrite(
    bot: Bot,
    channel: Channel,
    message: Message,
    text: string,
  ): Promise<Message> {
    const updated = await updateMessageBlocks(this.deps.db, message, [{ type: "text", text }], {
      type: "bot",
      id: bot.id,
      history: false,
    });
    await this.deps.bus.publish(
      "message.updated",
      { workspaceId: channel.workspaceId, channelId: channel.id, messageId: message.id },
      botActor(bot.id),
    );
    return updated;
  }

  /** Everything a tool can reach, which is only ever this bot's own channels and memories. */
  private hostFor(bot: Bot, channel: Channel, input: RunInput): BotHost {
    const threadRootId = input.message?.threadRootId ?? input.message?.id ?? null;
    return {
      postMessage: async ({ channel: where, text, threadRootId: root }) => {
        const found = await channelForBot(this.deps.db, bot.id, where);
        if (!found) throw PerchError.validation("this bot is not in that channel");
        const target = await getChannel(this.deps.db, found.id);
        if (!target) throw PerchError.notFound("channel");
        const asked = root ? ((await getMessage(this.deps.db, root)) ?? undefined) : undefined;
        // A reply goes under a message in the channel it is posted in, as over the Bot API.
        if (root && (!asked || asked.deletedAt || asked.channelId !== target.id)) {
          throw PerchError.notFound("message");
        }
        const posted = await this.say(bot, target, asked, text);
        return posted.id;
      },
      readChannel: async ({ channel: where, limit }) => {
        const found = await channelForBot(this.deps.db, bot.id, where);
        if (!found) throw PerchError.validation("this bot is not in that channel");
        const rows = await listMessages(this.deps.db, found.id, bot.ownerId, { limit });
        return rows.map(
          (row): ChatLine => ({
            author: row.authorName ?? (row.authorType === "bot" ? "a bot" : "someone"),
            text: textOf(row.blocks),
            at: row.createdAt.toISOString(),
          }),
        );
      },
      remember: async ({ content, scope }) => {
        if (bot.spec.memory?.longTerm === false) {
          throw PerchError.validation("this bot keeps nothing");
        }
        const where =
          scope === "thread" && threadRootId
            ? `thread:${threadRootId}`
            : scope === "channel"
              ? `channel:${channel.id}`
              : "global";
        await keepMemory(this.deps.db, {
          botId: bot.id,
          scope: where,
          content,
          ...(input.message ? { sourceMessageId: input.message.id } : {}),
        });
      },
      recall: async ({ query, limit }) => {
        const scopes = ["global", `channel:${channel.id}`];
        if (threadRootId) scopes.push(`thread:${threadRootId}`);
        const rows = await recallMemories(this.deps.db, {
          botId: bot.id,
          query,
          scopes,
          limit,
        });
        return rows.map(
          (row): MemoryHit => ({ content: row.content, at: row.createdAt.toISOString() }),
        );
      },
      threadFacts: async ({ values }) => {
        if (!threadRootId) return {};
        if (values && Object.keys(values).length > 0) {
          await upsertThreadFacts(this.deps.db, threadRootId, values, {
            type: "bot",
            id: bot.id,
          });
          // One event per key: the catalog's shape is one fact at a time (spec §7.7).
          for (const key of Object.keys(values)) {
            await this.deps.bus.publish(
              "thread.facts_updated",
              { workspaceId: channel.workspaceId, threadRootId, key },
              botActor(bot.id),
            );
          }
        }
        return threadFactsOf(this.deps.db, threadRootId);
      },
      fetchUrl: async ({ url }) => {
        const target = fetchable(url);
        const response = await fetch(target, {
          redirect: "follow",
          headers: { accept: "text/html,text/plain,application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        const body = await response.text();
        return { status: response.status, text: readable(body) };
      },
      mention: async ({ handle, text, mode }) => {
        if (!threadRootId) return { ok: false, reason: "there is no thread to tag anybody in" };
        const [tagged] = await botsByHandles(this.deps.db, channel.workspaceId, [
          handle.replace(/^@/, "").toLowerCase(),
        ]);
        if (!tagged) return { ok: false, reason: `there is no @${handle} here` };
        // Whether bots talk to each other here at all is the workspace's to say (spec §5.7).
        const rails = await this.deps.policy.evaluate(
          { workspaceId: channel.workspaceId },
          { kind: "bot.mention", ...(channel.name ? { channel: channel.name } : {}) },
        );
        if (!rails.allow) return { ok: false, reason: rails.reason };
        const state = await this.chainState(threadRootId, bot, channel);
        const verdict = mayHop(state, {
          fromType: "bot",
          fromId: bot.id,
          toBotId: tagged.id,
        });
        if (!verdict.ok) return { ok: false, reason: verdict.reason };
        // Tagging is saying their name: the same path a person's mention takes.
        const posted = await this.post(channel, threadRootId, bot, [
          { type: "text", text: `<@${tagged.handle}> ${text}` },
        ]);
        this.rememberMode(posted.id, mode);
        return { ok: true, hop: verdict.hop };
      },
      fanOut: async ({ tasks, wait, quorum, timeoutMs }) => {
        return await this.fanOut(bot, channel, threadRootId, {
          tasks,
          wait,
          ...(quorum === undefined ? {} : { quorum }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      },
      waitForReplies: async ({ handles, wait, quorum, timeoutMs }) =>
        await this.replies(bot, channel, threadRootId, {
          handles,
          wait,
          ...(quorum === undefined ? {} : { quorum }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      webSearch: async ({ query, limit }) => {
        const search = this.deps.search;
        if (!search) {
          throw PerchError.validation("web search is not configured on this Perch");
        }
        const url = new URL(search.url);
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(limit));
        const response = await fetch(url, {
          headers: {
            accept: "application/json",
            ...(search.key ? { "x-subscription-token": search.key } : {}),
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw PerchError.validation("the search endpoint refused that");
        return hitsOf(await response.json());
      },
    };
  }
}

/** A handle is what people type after an `@`: lower case, digits, dots and dashes. */
/** A bot's budget under the workspace's ceilings: the lower of the two, wherever both say a number. */
export function capped(
  budget: Bot["budget"],
  ceilings: { dailyUsd?: number; perRunUsd?: number; perThreadUsd?: number } | undefined,
): Bot["budget"] {
  if (!ceilings) return budget;
  const lower = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
  const dailyUsd = lower(budget.dailyUsd, ceilings.dailyUsd);
  const perRunUsd = lower(budget.perRunUsd, ceilings.perRunUsd);
  const perThreadUsd = lower(budget.perThreadUsd, ceilings.perThreadUsd);
  return {
    ...budget,
    ...(dailyUsd === undefined ? {} : { dailyUsd }),
    ...(perRunUsd === undefined ? {} : { perRunUsd }),
    ...(perThreadUsd === undefined ? {} : { perThreadUsd }),
  };
}

/** A spec whose triggers would stall the api is refused where it is saved (task 2.6; ADR-0176). */
function checkTriggers(spec: BotSpec): void {
  const problem = triggersProblem(spec);
  if (problem) throw PerchError.validation(problem);
}

export function normalizeHandle(raw: string): string {
  const handle = raw
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");
  if (handle.length < 2 || handle.length > 64) {
    throw PerchError.validation("a handle is between 2 and 64 characters");
  }
  return handle;
}

/** Every event a bot causes says which bot caused it (spec §7.7 actor). */
function botActor(botId: string): ActorContext {
  return { actor: { type: "bot", id: botId }, meta: {} };
}

/** A run that overran its budget says so under its answer rather than quietly. */
function withNote(text: string, stopped: string | undefined): string {
  return stopped ? `${text}\n\n_${stopped}._` : text;
}

/** A page as something a model can read: no markup, no scripts, and not the whole of it. */
export function readable(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = withoutScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 8_000 ? `${text.slice(0, 8_000)}…` : text;
}

/** Brave's answer shape, which is what most search endpoints imitate. */
function hitsOf(body: unknown): SearchHit[] {
  if (typeof body !== "object" || body === null) return [];
  const web = (body as { web?: { results?: unknown } }).web;
  const rows = Array.isArray(web?.results)
    ? web.results
    : Array.isArray((body as { results?: unknown }).results)
      ? (body as { results: unknown[] }).results
      : [];
  return rows.flatMap((row): SearchHit[] => {
    if (typeof row !== "object" || row === null) return [];
    const one = row as Record<string, unknown>;
    const url = typeof one.url === "string" ? one.url : "";
    if (!url) return [];
    return [
      {
        title: typeof one.title === "string" ? one.title : url,
        url,
        snippet:
          typeof one.description === "string"
            ? one.description
            : typeof one.snippet === "string"
              ? one.snippet
              : "",
      },
    ];
  });
}

/** What a thread's chain looks like from outside: the hops, and what they cost (spec §5.4). */
export type ChainView = {
  hops: {
    id: string;
    hop: number;
    fromType: "user" | "bot" | "system";
    fromId: string;
    fromName: string | null;
    toBotId: string;
    toName: string | null;
    mode: ChainMode;
    status: BotChain["status"];
    costUsd: number;
    at: string;
  }[];
  costUsd: number;
  stopped: boolean;
  breaker: string | null;
};

/** The bot behind an id, when it is one of this workspace's. */
export async function botFor(db: Db, workspaceId: string, id: string): Promise<Bot> {
  const bot = await getBot(db, id);
  if (!bot || bot.workspaceId !== workspaceId) throw PerchError.notFound("bot");
  return bot;
}

/**
 * Whether a firing that should have happened at `due` is still worth running now (task 3.5).
 *
 * A schedule catches up by default: Perch being down at nine is not a reason for the digest never
 * to arrive. `catchUp: false` says the opposite — a greeting that arrives at noon is worse than no
 * greeting — and `catchUpGraceMinutes` is the line between "late" and "too late".
 */
export function worthRunning(
  trigger: { catchUp?: boolean | undefined; catchUpGraceMinutes?: number | undefined },
  due: Date,
  now: Date,
): boolean {
  const lateMinutes = (now.getTime() - due.getTime()) / 60_000;
  // A minute either way is not late; clocks and pollers are not that precise.
  if (lateMinutes <= 1) return true;
  if (trigger.catchUp === false) return false;
  return lateMinutes <= (trigger.catchUpGraceMinutes ?? DEFAULT_CATCH_UP_MINUTES);
}
