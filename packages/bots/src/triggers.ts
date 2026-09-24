/**
 * What sets a bot off (spec §5.3 "Triggers: dm, mention, keyword/regex, channel join, schedule
 * (cron), inbound webhook, session events, reaction"; task 2.6).
 *
 * Matching is a pure function of the spec and what happened, so the rule a bot answers by can be
 * read — and tested — without a database, a model, or a channel.
 */
import type { BotSpec, BotTrigger, BotTriggerKind } from "@perch/db";
import { loadPatternEngine, testPattern } from "./sandbox.ts";

// The pattern engine is QuickJS, which loads asynchronously; starting now means it is there by the
// time the first message is. Until then a `regex: true` trigger does not fire.
void loadPatternEngine();

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

/** The longest `regex: true` pattern a bot may carry. */
export const PATTERN_MAX = 200;
/** How much of a message a bot's own pattern is run against. */
export const PATTERN_TEXT_MAX = 4_000;
/** How long one bot's pattern may take on one message before it counts as no match. */
const PATTERN_BUDGET_MS = 25;

/**
 * A keyword trigger. `match` is a comma-separated list of phrases, and each phrase fires on its
 * own, whole, as words — "look at this" is one phrase, not three words, and space inside it
 * matches any run of spaces. With `regex: true` it is the bot's own pattern, which is checked
 * (see `patternProblem`) and run in QuickJS on a time budget, because a pattern that backtracks on a
 * long message would otherwise hold the api's event loop for everybody.
 */
export function matchesKeyword(trigger: BotTrigger, text: string): boolean {
  const want = trigger.match?.trim();
  if (!want) return false;
  if (trigger.regex === true) {
    // A bot's own pattern, but a bad one is the bot's mistake, not the channel's problem: one that
    // fails the check, does not compile, or runs out of time is no match.
    if (patternProblem(want)) return false;
    return testPattern(want, text.slice(0, PATTERN_TEXT_MAX), PATTERN_BUDGET_MS) === true;
  }
  return want
    .split(",")
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .some((phrase) => {
      const words = phrase.split(/\s+/).map(escapeRegex).join("\\s+");
      return new RegExp(`(^|\\W)${words}(\\W|$)`, "i").test(text);
    });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Why a bot's own pattern is refused, or null when it may be saved. A quantifier on a group that
 * itself repeats or alternates (`(a+)+`, `(a|aa)*`) and a back-reference are the shapes whose
 * matching time can grow exponentially with the text, so they are refused outright; everything
 * else is still bounded by the budget `matchesKeyword` runs it on.
 */
export function patternProblem(pattern: string): string | null {
  if (pattern.length > PATTERN_MAX) return `a pattern is at most ${PATTERN_MAX} characters`;
  try {
    new RegExp(pattern, "i");
  } catch {
    return "that pattern is not a regular expression";
  }
  const nested = "a pattern cannot repeat a group that repeats or has alternatives in it";
  type Group = { repeats: boolean; alternates: boolean };
  const groups: Group[] = [{ repeats: false, alternates: false }];
  const top = (): Group => groups[groups.length - 1] ?? { repeats: false, alternates: false };
  let at = 0;
  while (at < pattern.length) {
    const char = pattern[at];
    if (char === "\\") {
      const next = pattern[at + 1] ?? "";
      if (/[1-9]/.test(next) || next === "k") return "a pattern cannot refer back to a group";
      at += 2;
    } else if (char === "[") {
      at += 1;
      if (pattern[at] === "^") at += 1;
      if (pattern[at] === "]") at += 1;
      while (at < pattern.length && pattern[at] !== "]") at += pattern[at] === "\\" ? 2 : 1;
      at += 1;
    } else if (char === "(") {
      groups.push({ repeats: false, alternates: false });
      at += 1;
      if (pattern[at] === "?") {
        at += 1;
        const named = pattern[at] === "<" && pattern[at + 1] !== "=" && pattern[at + 1] !== "!";
        const close = pattern.indexOf(">", at);
        if (named) at = close < 0 ? pattern.length : close + 1;
        else at += pattern[at] === "<" ? 2 : 1;
      }
      continue;
    } else if (char === ")") {
      const inner = groups.pop() ?? { repeats: false, alternates: false };
      const after = quantifier(pattern, at + 1);
      if (after.repeats && (inner.repeats || inner.alternates)) return nested;
      const outer = top();
      outer.repeats = outer.repeats || inner.repeats || after.repeats;
      at = after.end;
      continue;
    } else if (char === "|") {
      top().alternates = true;
      at += 1;
      continue;
    } else {
      at += 1;
    }
    const after = quantifier(pattern, at);
    if (after.repeats) top().repeats = true;
    at = after.end;
  }
  return null;
}

/**
 * Why a spec cannot be saved because of its triggers, or null. Every road a spec takes into the
 * database — the Forge, a Hub install, a `bot.yaml` sync — asks this, so a pattern that would stall
 * the api is refused where it is written rather than discovered where it runs.
 */
export function triggersProblem(spec: BotSpec): string | null {
  for (const trigger of spec.triggers ?? []) {
    if (trigger.on !== "keyword" || trigger.regex !== true || !trigger.match) continue;
    const problem = patternProblem(trigger.match.trim());
    if (problem) return `the keyword pattern ${JSON.stringify(trigger.match)}: ${problem}`;
  }
  return null;
}

/** The quantifier at `at`, if any: whether it can match its atom more than once, and where it ends. */
function quantifier(pattern: string, at: number): { repeats: boolean; end: number } {
  const char = pattern[at];
  let repeats = false;
  let end = at;
  if (char === "*" || char === "+") {
    repeats = true;
    end = at + 1;
  } else if (char === "?") {
    end = at + 1;
  } else if (char === "{") {
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at));
    if (braces) {
      const [whole, least, comma, most] = braces;
      repeats = comma !== undefined ? most === "" || Number(most) > 1 : Number(least) > 1;
      end = at + whole.length;
    }
  }
  // A lazy quantifier (`+?`) is still the quantifier it modifies.
  if (end > at && pattern[end] === "?") end += 1;
  return { repeats, end };
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
