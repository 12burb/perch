import { describe, expect, test } from "bun:test";
import type { BotSpec } from "@perch/db";
import { firesOn, inScope, matchesKeyword, names, schedules } from "../src/triggers.ts";

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
