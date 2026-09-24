/**
 * Bot API events (spec §7.3: "Events via wss:///api/bot/socket or HMAC-signed webhook:
 * message.created, app_mention …, interaction.received, session.completed, work_item.updated").
 *
 * These are not bus events. The bus catalog is §7.7's list and nothing else (`packages/events`);
 * this is the outward-facing shape a bot is handed, which is Slack-shaped on purpose so that
 * anybody who has written a Slack app can read it.
 *
 * Task 2.5 shipped the envelope, the dispatcher, and the one event a person can cause on their own —
 * `interaction.received`. The transport — the Bot API's socket; §7.3's signed webhook is not built
 * (ADR-0176) — subscribes here rather than being wired into the features that emit, and asks
 * `deliversTo` which bot hears what.
 */
import { z } from "zod";

export const BOT_EVENTS = [
  "message.created",
  "app_mention",
  "reaction.added",
  "channel.joined",
  "interaction.received",
  "session.completed",
  "work_item.updated",
] as const;
export type BotEventName = (typeof BOT_EVENTS)[number];

/** Who did it. A bot is told the kind, never a credential (AGENTS §1.6). */
export const botActorSchema = z
  .object({
    type: z.enum(["user", "bot"]),
    id: z.uuid(),
    name: z.string().optional(),
    handle: z.string().optional(),
  })
  .strict();
export type BotActor = z.infer<typeof botActorSchema>;

/**
 * `interaction.received` (spec §5.2: "interactions post interaction.received {block id, values,
 * user, message} to the owning bot over the Bot API and update the block in place").
 */
export const interactionReceivedSchema = z
  .object({
    workspace_id: z.uuid(),
    channel_id: z.uuid(),
    message_id: z.uuid(),
    /** The block that was acted on, and the action it named. */
    block_id: z.string().min(1),
    action: z.string().min(1),
    block_type: z.enum(["button", "select", "form", "approve_deny"]),
    /** What was chosen or typed: one entry for a button or a select, one per field for a form. */
    values: z.record(z.string(), z.string()),
    user: botActorSchema,
    at: z.string(),
  })
  .strict();
export type InteractionReceived = z.infer<typeof interactionReceivedSchema>;

/** A message as a bot is told about it (spec §7.3 `message.created`). */
export const messageCreatedSchema = z
  .object({
    workspace_id: z.uuid(),
    channel_id: z.uuid(),
    channel_name: z.string().nullable(),
    message_id: z.uuid(),
    /** The thread this is in, when it is in one; a root message has none. */
    thread_root_id: z.uuid().nullable(),
    text: z.string(),
    blocks: z.array(z.looseObject({ type: z.string() })),
    user: botActorSchema,
    ts: z.string(),
  })
  .strict();
export type MessageCreated = z.infer<typeof messageCreatedSchema>;

/**
 * `app_mention` (spec §7.3 `{mentioned_by, mode, root_id, hop, budget_remaining}`): somebody said
 * this bot's name. A bot saying it counts the same as a person saying it, which is what makes a
 * chain a chain — and why the hop and what is left of the budget travel with it. They are the chain
 * state the native runtime keeps (spec §5.4), and a hop its rails forbid is not delivered at all.
 */
export const appMentionSchema = messageCreatedSchema
  .extend({
    mentioned_by: botActorSchema,
    /** How a bot meant the tag (spec §5.4): consult, handoff, fan-out; null for a person's. */
    mode: z.string().nullable(),
    root_id: z.uuid(),
    /** Which hop of the thread's chain this is: 1 for the first tag. */
    hop: z.number().int().nonnegative(),
    /** What is left of the chain's budget in dollars, or null when nothing caps it. */
    budget_remaining: z.number().nullable(),
  })
  .strict();
export type AppMention = z.infer<typeof appMentionSchema>;

export const reactionAddedSchema = z
  .object({
    workspace_id: z.uuid(),
    channel_id: z.uuid(),
    message_id: z.uuid(),
    emoji: z.string().min(1),
    user: botActorSchema,
    ts: z.string(),
  })
  .strict();
export type ReactionAdded = z.infer<typeof reactionAddedSchema>;

export const channelJoinedSchema = z
  .object({
    workspace_id: z.uuid(),
    channel_id: z.uuid(),
    channel_name: z.string().nullable(),
    ts: z.string(),
  })
  .strict();
export type ChannelJoined = z.infer<typeof channelJoinedSchema>;

export const sessionCompletedSchema = z
  .object({
    workspace_id: z.uuid(),
    session_id: z.uuid(),
    project_id: z.uuid(),
    status: z.string(),
    /** Why it ended that way, when there is a reason; never a credential. */
    message: z.string().nullable(),
    ts: z.string(),
  })
  .strict();
export type SessionCompleted = z.infer<typeof sessionCompletedSchema>;

/**
 * `work_item.updated` (spec §7.3; task 3.13). A bot hears what moved rather than the whole item,
 * because a bot that cares reads the item and a bot that does not should not be handed it.
 */
export const workItemUpdatedSchema = z
  .object({
    workspace_id: z.uuid(),
    project_id: z.uuid(),
    work_item_id: z.uuid(),
    /** `KEY-123`, so a bot can say it out loud without another call. */
    identifier: z.string(),
    title: z.string(),
    state: z.string(),
    /** Which fields moved: "state", "assignee", "title" … */
    changes: z.array(z.string()),
    assignee_type: z.string().nullable(),
    assignee_id: z.uuid().nullable(),
    ts: z.string(),
  })
  .strict();
export type WorkItemUpdated = z.infer<typeof workItemUpdatedSchema>;

export type BotEventPayloads = {
  "message.created": MessageCreated;
  app_mention: AppMention;
  "reaction.added": ReactionAdded;
  "channel.joined": ChannelJoined;
  "interaction.received": InteractionReceived;
  "session.completed": SessionCompleted;
  "work_item.updated": WorkItemUpdated;
};

/** The envelope every transport wraps: which bot it is for, what happened, and when. */
export type BotEvent<T extends keyof BotEventPayloads = keyof BotEventPayloads> = {
  type: T;
  /** The bot this is addressed to; null while nothing owns the block (until task 2.6). */
  botId: string | null;
  workspaceId: string;
  payload: BotEventPayloads[T];
  ts: string;
};

/**
 * The events a bot hears without being addressed: its own workspace's news (spec §7.3
 * `session.completed`, `work_item.updated`). Anything else with no bot on it — a button pressed
 * on a block a person posted — is nobody's to hear.
 */
const WORKSPACE_WIDE: ReadonlySet<BotEventName> = new Set([
  "session.completed",
  "work_item.updated",
]);

/**
 * Whether `bot` is told about `event`. Every transport asks this and nothing else, so what one
 * delivers another cannot: never an event from another workspace, and an addressed one only to the
 * bot it names.
 */
export function deliversTo(event: BotEvent, bot: { id: string; workspaceId: string }): boolean {
  if (event.workspaceId !== bot.workspaceId) return false;
  if (event.botId !== null) return event.botId === bot.id;
  return WORKSPACE_WIDE.has(event.type);
}

export type BotEventHandler = (event: BotEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

/**
 * Where bot events are handed over. In-process, like the bus: a subscriber that throws never fails
 * the person who clicked the button, and an event with nobody listening is not an error — until
 * 2.6 there is nothing to listen.
 */
export interface BotEvents {
  emit<T extends keyof BotEventPayloads>(event: BotEvent<T>): Promise<void>;
  subscribe(handler: BotEventHandler): Unsubscribe;
}

export type BotEventsOptions = { onError?: (error: unknown, event: BotEvent) => void };

export function createBotEvents(options: BotEventsOptions = {}): BotEvents {
  const handlers = new Set<BotEventHandler>();
  return {
    async emit(event) {
      for (const handler of handlers) {
        try {
          await handler(event as BotEvent);
        } catch (error) {
          options.onError?.(error, event as BotEvent);
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
