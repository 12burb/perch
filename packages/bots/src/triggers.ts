/**
 * What sets a bot off (spec §5.3 "Triggers: dm, mention, keyword/regex, channel join, schedule
 * (cron), inbound webhook, session events, reaction"; task 2.6).
 *
 * Matching is a pure function of the spec and what happened, so the rule a bot answers by can be
 * read — and tested — without a database, a model, or a channel.
 */
import type { BotSpec, BotTrigger, BotTriggerKind } from "@perch/db";

/** What a bot is told about, in the shape the matcher needs. */
export type TriggerEvent =
  | {
      kind: "message";
      channelId: string;
      /** `dm` and `group` are a conversation with the bot; anything else is a room. */
      channelType: string;
      text: string;
      /** The handles named in the message, lower case, without the `<@…>`. */
      mentions: string[];
      authorType: "user" | "bot" | "system";
      authorId: string;
    }
  | { kind: "channel_join"; channelId: string; botId: string }
  | {
      kind: "reaction";
      channelId: string;
      emoji: string;
      authorType: "user" | "bot";
      authorId: string;
    }
  | {
      /** A provider said something happened (spec §3.5, §5.3 `webhook`; task 3.4). */
      kind: "webhook";
      channelId: string;
      provider: string;
      /** What the provider calls it, which is what `match:` narrows on. */
      event: string | null;
    };

export type TriggerMatch = { on: BotTriggerKind; trigger: BotTrigger };

/** A `<@handle>` in the text, or a bare `@handle` somebody typed without the composer. */
export function names(text: string, handle: string): boolean {
  const wanted = handle.toLowerCase();
  const pattern = /<@([a-z0-9._-]{1,64})>|(?:^|[\s(])@([a-z0-9._-]{1,64})/gi;
  for (const match of text.matchAll(pattern)) {
    const named = (match[1] ?? match[2] ?? "").toLowerCase();
    if (named === wanted) return true;
  }
  return false;
}

/** A keyword trigger: whole words by default, the pattern itself when the trigger says regex. */
export function matchesKeyword(trigger: BotTrigger, text: string): boolean {
  const want = trigger.match?.trim();
  if (!want) return false;
  if (trigger.regex === true) {
    // A bot's own pattern, but a bad one is the bot's mistake, not the channel's problem.
    try {
      return new RegExp(want, "i").test(text);
    } catch {
      return false;
    }
  }
  return want
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((word) => new RegExp(`(^|\\W)${escapeRegex(word)}(\\W|$)`, "i").test(text));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The first trigger that fires, or null. A bot never answers itself — that is how a room fills up
 * with two bots talking — and a trigger the runtime has no transport for yet (webhook, schedule)
 * is not matched here: those arrive by their own road.
 */
export function firesOn(
  bot: { id: string; handle: string; spec: BotSpec },
  event: TriggerEvent,
): TriggerMatch | null {
  const triggers = bot.spec.triggers ?? [];
  if (triggers.length === 0) return null;
  if (event.kind === "message" && event.authorType === "bot" && event.authorId === bot.id) {
    return null;
  }
  if (event.kind === "reaction" && event.authorType === "bot" && event.authorId === bot.id) {
    return null;
  }
  for (const trigger of triggers) {
    if (!fires(bot, trigger, event)) continue;
    return { on: trigger.on, trigger };
  }
  return null;
}

function fires(
  bot: { id: string; handle: string },
  trigger: BotTrigger,
  event: TriggerEvent,
): boolean {
  switch (trigger.on) {
    case "dm":
      return (
        event.kind === "message" &&
        (event.channelType === "dm" || event.channelType === "group") &&
        event.authorType !== "system"
      );
    case "mention":
      return event.kind === "message" && event.mentions.includes(bot.handle.toLowerCase());
    case "keyword":
      return event.kind === "message" && matchesKeyword(trigger, event.text);
    case "channel_join":
      // The bot's own arrival, not everybody else's: a greeting, not a doorbell (ADR-0096).
      return event.kind === "channel_join" && event.botId === bot.id;
    case "reaction": {
      if (event.kind !== "reaction") return false;
      const want = trigger.match?.trim();
      return !want || want === event.emoji;
    }
    case "webhook": {
      if (event.kind !== "webhook") return false;
      // `match:` narrows to one provider, or to `provider:event` when a bot wants only one thing.
      const want = trigger.match?.trim().toLowerCase();
      if (!want) return true;
      const [provider, named] = want.split(":");
      if (provider && provider !== event.provider.toLowerCase()) return false;
      return !named || named === (event.event ?? "").toLowerCase();
    }
    default:
      return false;
  }
}

/** The scheduled triggers, which the queue runs rather than the bus (spec §5.3 `schedule (cron)`). */
export function schedules(spec: BotSpec): BotTrigger[] {
  return (spec.triggers ?? []).filter(
    (trigger) => trigger.on === "schedule" && typeof trigger.cron === "string",
  );
}

/** Whether this bot works in this channel at all (spec §5.3 `scope {channels [...]}`). */
export function inScope(spec: BotSpec, channel: { id: string; name: string | null }): boolean {
  const allowed = spec.scope?.channels ?? [];
  if (allowed.length === 0) return true;
  const name = channel.name?.toLowerCase() ?? "";
  return allowed.some((entry) => {
    const want = entry.replace(/^#/, "").toLowerCase();
    return want === channel.id.toLowerCase() || (name !== "" && want === name);
  });
}
