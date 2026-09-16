/**
 * Bot API events (spec §7.3: "Events via wss:///api/bot/socket or HMAC-signed webhook:
 * message.created, app_mention …, interaction.received, session.completed, work_item.updated").
 *
 * These are not bus events. The bus catalog is §7.7's list and nothing else (`packages/events`);
 * this is the outward-facing shape a bot is handed, which is Slack-shaped on purpose so that
 * anybody who has written a Slack app can read it.
 *
 * Task 2.5 ships the envelope, the dispatcher, and the one event a person can cause on their own —
 * `interaction.received`. The transports (the socket and the signed webhook) arrive with the bot
 * runtime in 2.6 and its webhooks in 2.7; they subscribe here rather than being wired into the
 * features that emit.
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
 * chain a chain — and why the hop and what is left of the budget travel with it.
 */
export const appMentionSchema = messageCreatedSchema
  .extend({
    mentioned_by: botActorSchema,
    /** How the tag was meant when a bot made it (spec §5.4): consult, handoff, fan-out. */
    mode: z.string().nullable(),
    root_id: z.uuid(),
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

export type BotEventPayloads = {
  "message.created": MessageCreated;
  app_mention: AppMention;
  "reaction.added": ReactionAdded;
  "channel.joined": ChannelJoined;
  "interaction.received": InteractionReceived;
  "session.completed": SessionCompleted;
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
