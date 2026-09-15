// @perch/bots — Bot runtime: triggers, tools, chains, QuickJS sandbox, Bot API handlers (spec §5.3, §5.4).
export const packageName = "@perch/bots";

export {
  BOT_EVENTS,
  type BotActor,
  type BotEvent,
  type BotEventHandler,
  type BotEventName,
  type BotEventPayloads,
  type BotEvents,
  type BotEventsOptions,
  botActorSchema,
  createBotEvents,
  type InteractionReceived,
  interactionReceivedSchema,
  type Unsubscribe,
} from "./events.ts";
