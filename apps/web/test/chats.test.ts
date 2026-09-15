import { describe, expect, test } from "bun:test";
import { botChats, titleOf } from "../src/chat/chats.ts";
import type { ChannelRow } from "../src/lib/queries.ts";

/** Task 2.9: a chat with a bot is a DM of two, and it is named by what started it. */

const room = (over: Partial<ChannelRow> & { id: string }): ChannelRow => ({
  type: "dm",
  name: null,
  topic: null,
  project_id: null,
  archived: false,
  member: true,
  unread: 0,
  mentions: 0,
  member_count: 2,
  created_at: "2026-09-15T00:00:00.000Z",
  ...over,
});

describe("botChats", () => {
  test("a DM of two with a bot in it is that bot's chat", () => {
    const channels = [
      room({ id: "with-ada" }),
      room({ id: "with-a-person" }),
      room({ id: "a-room", type: "public", name: "general", member_count: 5 }),
      room({ id: "a-group", type: "group", member_count: 3 }),
    ];
    const chats = botChats([{ id: "ada", channels: ["with-ada", "a-room"] }], channels);
    expect(chats.get("ada")?.id).toBe("with-ada");
    expect(chats.size).toBe(1);
  });

  test("a room you have left, or one that was put away, is nobody's chat", () => {
    const bots = [{ id: "ada", channels: ["gone", "archived"] }];
    const channels = [
      room({ id: "gone", member: false }),
      room({ id: "archived", archived: true }),
    ];
    expect(botChats(bots, channels).size).toBe(0);
  });
});

describe("titleOf", () => {
  test("the first line, on one line, and short enough to read", () => {
    expect(titleOf("when are we\ndeploying?", "Untitled")).toBe("when are we deploying?");
    expect(titleOf("   ", "Untitled")).toBe("Untitled");
    const long = titleOf("x".repeat(80), "Untitled");
    expect(long).toHaveLength(48);
    expect(long.endsWith("…")).toBe(true);
  });
});
