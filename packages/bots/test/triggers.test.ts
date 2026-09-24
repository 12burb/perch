import { beforeAll, describe, expect, test } from "bun:test";
import type { BotSpec } from "@perch/db";
import { loadPatternEngine } from "../src/sandbox.ts";
import {
  firesOn,
  inScope,
  matchesKeyword,
  names,
  patternProblem,
  schedules,
} from "../src/triggers.ts";

/** Task 2.6: what sets a bot off (spec §5.3 "Triggers"). */

const BOT = "8f2c0a3e-0000-4000-8000-000000000001";
const OTHER = "8f2c0a3e-0000-4000-8000-000000000002";

function bot(spec: BotSpec) {
  return { id: BOT, handle: "wren", spec };
}

function said(
  text: string,
  extra: Partial<{
    channelType: string;
    authorType: "user" | "bot" | "system";
    authorId: string;
    mentions: string[];
  }> = {},
) {
  return {
    kind: "message" as const,
    channelId: "c1",
    channelType: extra.channelType ?? "public",
    text,
    mentions:
      extra.mentions ??
      [...text.matchAll(/<@([a-z0-9._-]+)>/gi)].map((m) => (m[1] ?? "").toLowerCase()),
    authorType: extra.authorType ?? ("user" as const),
    authorId: extra.authorId ?? OTHER,
  };
}

describe("triggers (task 2.6)", () => {
  // A `regex: true` trigger runs in QuickJS, which loads asynchronously; until it has, none fires.
  beforeAll(async () => {
    await loadPatternEngine();
  });

  test("a mention is the handle, however it was typed", () => {
    expect(names("morning <@wren>", "wren")).toBe(true);
    expect(names("morning @Wren", "wren")).toBe(true);
    expect(names("an email@wren.example is not one", "wren")).toBe(false);
    expect(names("<@robin> knows", "wren")).toBe(false);
  });

  test("mention fires, and a bot never answers itself", () => {
    const wren = bot({ triggers: [{ on: "mention" }] });
    expect(firesOn(wren, said("<@wren> what broke?"))?.on).toBe("mention");
    expect(firesOn(wren, said("nothing to do with it"))).toBeNull();
    // Its own message, mentioning itself, is not a conversation with itself.
    expect(firesOn(wren, said("<@wren> done", { authorType: "bot", authorId: BOT }))).toBeNull();
    // Another bot's mention does fire: that is how bots tag bots (task 2.7).
    expect(
      firesOn(wren, said("<@wren> take this", { authorType: "bot", authorId: OTHER }))?.on,
    ).toBe("mention");
  });

  test("dm fires in a conversation, not in a room", () => {
    const wren = bot({ triggers: [{ on: "dm" }] });
    expect(firesOn(wren, said("hello", { channelType: "dm" }))?.on).toBe("dm");
    expect(firesOn(wren, said("hello", { channelType: "group" }))?.on).toBe("dm");
    expect(firesOn(wren, said("hello", { channelType: "public" }))).toBeNull();
  });

  test("keywords are whole words, and a regex is the pattern itself", () => {
    expect(matchesKeyword({ on: "keyword", match: "deploy, release" }, "time to deploy")).toBe(
      true,
    );
    expect(matchesKeyword({ on: "keyword", match: "deploy" }, "redeployment")).toBe(false);
    expect(
      matchesKeyword({ on: "keyword", match: "PERCH-\\d+", regex: true }, "see PERCH-42"),
    ).toBe(true);
    // A pattern that does not compile is the bot's mistake, not the channel's problem.
    expect(matchesKeyword({ on: "keyword", match: "(unclosed", regex: true }, "anything")).toBe(
      false,
    );
    expect(matchesKeyword({ on: "keyword" }, "anything")).toBe(false);
  });

  test("a keyword is a whole phrase between commas, not every word in it", () => {
    const reviewer = { on: "keyword" as const, match: "review, look at this" };
    expect(matchesKeyword(reviewer, "meet at noon")).toBe(false);
    expect(matchesKeyword(reviewer, "is this ready?")).toBe(false);
    expect(matchesKeyword(reviewer, "could you look at this PR")).toBe(true);
    expect(matchesKeyword(reviewer, "could you look  at\nthis PR")).toBe(true);
    expect(matchesKeyword(reviewer, "ready for review")).toBe(true);
    const notes = { on: "keyword" as const, match: "show notes" };
    expect(matchesKeyword(notes, "show me the build")).toBe(false);
    expect(matchesKeyword(notes, "my notes from today")).toBe(false);
    expect(matchesKeyword(notes, "draft the Show Notes please")).toBe(true);
    // Punctuation inside a phrase is literal, and a lone comma is no phrase at all.
    expect(matchesKeyword({ on: "keyword", match: "v1.2" }, "shipping v1.2 today")).toBe(true);
    expect(matchesKeyword({ on: "keyword", match: "v1.2" }, "shipping v1x2 today")).toBe(false);
    expect(matchesKeyword({ on: "keyword", match: " , " }, "anything")).toBe(false);
  });

  test("a regex a person could write by mistake to stall the api is refused, and none runs long", () => {
    expect(patternProblem("^(a+)+$")).not.toBeNull();
    expect(patternProblem("(a|aa)*b")).not.toBeNull();
    expect(patternProblem("(x+x+)+y")).not.toBeNull();
    expect(patternProblem("(\\w+)\\1")).not.toBeNull();
    expect(patternProblem("(unclosed")).not.toBeNull();
    expect(patternProblem("x".repeat(201))).not.toBeNull();
    expect(patternProblem("PERCH-\\d+")).toBeNull();
    expect(patternProblem("\\b(deploy|release)\\b")).toBeNull();
    expect(patternProblem("^!help( \\w+)?$")).toBeNull();
    // A nested quantifier is refused where it is tested, too, for a bot saved before the check.
    expect(
      matchesKeyword({ on: "keyword", match: "^(a+)+$", regex: true }, `${"a".repeat(40)}!`),
    ).toBe(false);
  });

  test("a regex that passes the check but backtracks hard is stopped at its budget", () => {
    const slow = { on: "keyword" as const, match: ".*.*x", regex: true };
    const started = performance.now();
    expect(matchesKeyword(slow, "a".repeat(2_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
    // …and a pattern that answers in time still answers.
    expect(matchesKeyword(slow, "a lot of text and then an x")).toBe(true);
  });

  test("channel join is the bot's own arrival; a reaction can be any emoji or one", () => {
    const joiner = bot({ triggers: [{ on: "channel_join" }] });
    expect(firesOn(joiner, { kind: "channel_join", channelId: "c1", botId: BOT })?.on).toBe(
      "channel_join",
    );
    expect(firesOn(joiner, { kind: "channel_join", channelId: "c1", botId: OTHER })).toBeNull();

    const eyes = bot({ triggers: [{ on: "reaction", match: "\u{1F440}" }] });
    const reaction = {
      kind: "reaction" as const,
      channelId: "c1",
      authorType: "user" as const,
      authorId: OTHER,
    };
    expect(firesOn(eyes, { ...reaction, emoji: "\u{1F440}" })?.on).toBe("reaction");
    expect(firesOn(eyes, { ...reaction, emoji: "\u{1F389}" })).toBeNull();
    const any = bot({ triggers: [{ on: "reaction" }] });
    expect(firesOn(any, { ...reaction, emoji: "\u{1F389}" })?.on).toBe("reaction");
    // Its own reaction is not a summons either.
    expect(
      firesOn(any, { ...reaction, emoji: "\u{1F389}", authorType: "bot", authorId: BOT }),
    ).toBeNull();
  });

  test("a bot with no triggers answers nothing", () => {
    expect(firesOn(bot({}), said("<@wren> hello"))).toBeNull();
  });

  test("schedules are the queue's, not the bus's", () => {
    const spec: BotSpec = {
      triggers: [
        { on: "mention" },
        { on: "schedule", cron: "0 9 * * 1-5", prompt: "post the headlines", channel: "newsroom" },
      ],
    };
    expect(schedules(spec)).toHaveLength(1);
    expect(schedules(spec)[0]?.cron).toBe("0 9 * * 1-5");
    // The matcher leaves them alone: a cron does not fire because somebody said something.
    expect(firesOn(bot(spec), said("morning"))).toBeNull();
  });

  test("scope decides where it works at all", () => {
    const spec: BotSpec = { scope: { channels: ["#newsroom", "general"] } };
    expect(inScope(spec, { id: "c1", name: "newsroom" })).toBe(true);
    expect(inScope(spec, { id: "c2", name: "General" })).toBe(true);
    expect(inScope(spec, { id: "c3", name: "random" })).toBe(false);
    expect(inScope(spec, { id: "c4", name: null })).toBe(false);
    // No scope means wherever it has been installed.
    expect(inScope({}, { id: "c5", name: "anywhere" })).toBe(true);
  });
});
