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
import {
  type BotEvents,
  type BotHost,
  budgetLeft,
  type ChatLine,
  firesOn,
  inScope,
  type MemoryHit,
  runBot,
  type SearchHit,
  schedules,
  type TriggerEvent,
  toolsFor,
  withinBudget,
} from "@perch/bots";
import type { Bus } from "@perch/bus";
import type {
  Bot,
  BotInstall,
  BotRun,
  BotSpec,
  BotTool,
  Channel,
  Db,
  Message,
  MessageBlock,
} from "@perch/db";
import type { ModelMessage } from "@perch/gateway";
import type { Queue } from "@perch/jobs";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  botByHandle,
  botsInChannel,
  channelForBot,
  deleteBot,
  finishRun,
  getBot,
  insertBot,
  installBot,
  installsOf,
  keepMemory,
  recallMemories,
  spending,
  startRun,
  uninstallBot,
  updateBot,
} from "../repos/bots.ts";
import { getChannel } from "../repos/channels.ts";
import { getMessage, insertMessage, listMessages, updateMessageBlocks } from "../repos/messages.ts";
import { threadFactsOf, upsertThreadFacts } from "../repos/threads.ts";
import { handleTaken } from "../repos/users.ts";
import type { BrainsService } from "./brains.ts";

export type BotsDeps = {
  db: Db;
  bus: Bus;
  botEvents: BotEvents;
  brains: BrainsService;
  /** Where a bot's scheduled triggers live (spec §5.3 `schedule (cron)`). */
  queue: Queue;
  log: Logger;
  /** The search endpoint a bot's web_search uses, when this Perch has one. */
  search?: { url: string; key: string | undefined } | undefined;
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
  /** A run with no message of its own: a schedule, or the Forge's test chat. */
  prompt?: string | undefined;
  by: ActorContext;
  /** The answer is posted where it was asked; a test run keeps it to itself. */
  quiet?: boolean;
};

export type RunOutcome = { run: BotRun; text: string };

const DEFAULT_WINDOW = 20;
const PLACEHOLDER = "…";
/** The queue a bot's scheduled triggers run on. */
export const BOT_QUEUE = "bots";
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
  jobHandlers(): Record<string, (job: { payload: Record<string, unknown> }) => Promise<void>> {
    return { [BOT_QUEUE]: (job) => this.runScheduled(job.payload) };
  }

  /** One firing of a cron trigger: the prompt it carries, in the channel it names. */
  async runScheduled(payload: Record<string, unknown>): Promise<void> {
    const botId = typeof payload.botId === "string" ? payload.botId : "";
    const index = typeof payload.index === "number" ? payload.index : -1;
    const bot = botId ? await getBot(this.deps.db, botId) : null;
    if (bot?.status !== "active") return;
    const trigger = schedules(bot.spec)[index];
    if (!trigger) return;
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

  /** Where a bot has been put. */
  installsOf(botId: string): Promise<BotInstall[]> {
    return installsOf(this.deps.db, botId);
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

  /** Every bot in the channel is offered what happened; the ones whose triggers fire answer. */
  private async offer(channel: Channel, event: TriggerEvent, message: Message): Promise<void> {
    const installed = await botsInChannel(this.deps.db, channel.id);
    for (const { bot, install } of installed) {
      if (bot.status !== "active") continue;
      if (!inScope(bot.spec, { id: channel.id, name: channel.name })) continue;
      const fired = firesOn({ id: bot.id, handle: bot.handle, spec: bot.spec }, event);
      if (!fired) continue;
      await this.run({
        bot,
        channel,
        trigger: fired.on,
        triggerRef: message.id,
        message,
        install,
        by: botActor(bot.id),
      });
    }
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
    by: ActorContext;
  }): Promise<Bot> {
    const handle = normalizeHandle(input.handle);
    if (await botByHandle(this.deps.db, input.workspaceId, handle)) {
      throw PerchError.conflict("that handle is taken");
    }
    if (await handleTaken(this.deps.db, handle)) {
      throw PerchError.conflict("that handle belongs to somebody");
    }
    const bot = await insertBot(this.deps.db, {
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      handle,
      name: input.name,
      level: "ui",
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
  async run(input: RunInput): Promise<RunOutcome> {
    const { bot, channel } = input;
    const now = new Date();
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const hour = new Date(now.getTime() - 60 * 60 * 1000);
    const state = await spending(this.deps.db, bot.id, { day, hour });
    const verdict = withinBudget(bot.budget, state);

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

    let placeholder: Message | null = null;
    try {
      const profile = await this.brainFor(bot);
      const model = await this.deps.brains.languageModel(profile, bot.ownerId);
      const messages = await this.conversation(bot, channel, input);
      const allowed = this.toolsAllowed(bot.spec, input.install ?? null);
      const tools = toolsFor(allowed, this.hostFor(bot, channel, input));
      placeholder = input.quiet ? null : await this.say(bot, channel, input.message, PLACEHOLDER);

      const result = await runBot({
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
      });

      // The answer is already in the message; only a note about an overrun needs another write.
      const said = withNote(result.text, result.stopped);
      if (placeholder && result.stopped) {
        placeholder = await this.rewrite(bot, channel, placeholder, said);
      }
      const ended = await finishRun(this.deps.db, run.id, {
        status: "done",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        modelId: profile.modelId,
      });
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
      return { run: ended ?? run, text: said };
    } catch (error) {
      const why = error instanceof PerchError ? error.message : "this bot could not answer";
      this.deps.log.error({ err: error, botId: bot.id }, "bot run failed");
      if (placeholder) await this.rewrite(bot, channel, placeholder, why);
      else if (!input.quiet) await this.say(bot, channel, input.message, why);
      const ended = await finishRun(this.deps.db, run.id, { status: "error", error: why });
      await this.deps.bus.publish(
        "bot.run_failed",
        { workspaceId: channel.workspaceId, botId: bot.id, runId: run.id, error: why },
        input.by,
      );
      return { run: ended ?? run, text: why };
    }
  }

  /** The brain the spec names, or the workspace's default for chat. */
  private async brainFor(bot: Bot) {
    const wanted = bot.spec.brain?.profile;
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

  /** What the bot is shown: the last of the thread, oldest first, in the model's own shape. */
  private async conversation(bot: Bot, channel: Channel, input: RunInput): Promise<ModelMessage[]> {
    if (input.prompt && !input.message) {
      return [{ role: "user", content: input.prompt }];
    }
    const window = bot.spec.memory?.window ?? DEFAULT_WINDOW;
    const rootId = input.message?.threadRootId ?? input.message?.id;
    const rows = await listMessages(this.deps.db, channel.id, bot.ownerId, {
      limit: window,
      ...(rootId && input.message?.threadRootId ? { threadRootId: rootId } : {}),
    });
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
    // A room keeps the answer in a thread; a conversation with the bot is already one.
    const inThread = asked && channel.type !== "dm" && channel.type !== "group";
    const threadRootId = inThread ? (asked.threadRootId ?? asked.id) : null;
    const message = await insertMessage(this.deps.db, {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      threadRootId,
      authorType: "bot",
      authorId: bot.id,
      blocks: [{ type: "text", text }],
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

/** The bot behind an id, when it is one of this workspace's. */
export async function botFor(db: Db, workspaceId: string, id: string): Promise<Bot> {
  const bot = await getBot(db, id);
  if (!bot || bot.workspaceId !== workspaceId) throw PerchError.notFound("bot");
  return bot;
}
