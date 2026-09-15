/**
 * The plain parts of a chat with a bot (spec §5.2 "DM-a-bot"; task 2.9): which room belongs to
 * which bot, and what one chat inside it is called. No React and no UI, so they can be read — and
 * tested — on their own.
 */
import type { ChannelRow } from "../lib/queries.ts";

/**
 * Which bot each chat belongs to: a DM of two whose other member is a bot. The bots already say
 * where they are installed, so nothing else has to be asked for.
 */
export function botChats(
  bots: { id: string; channels: string[] }[],
  channels: ChannelRow[],
): Map<string, ChannelRow> {
  const rooms = new Map(
    channels
      .filter((c) => c.member && !c.archived && c.type === "dm" && c.member_count === 2)
      .map((c) => [c.id, c]),
  );
  const chats = new Map<string, ChannelRow>();
  for (const bot of bots) {
    for (const id of bot.channels) {
      const room = rooms.get(id);
      if (room) chats.set(bot.id, room);
    }
  }
  return chats;
}

/** What a chat is called in the picker: the first line of the message that started it. */
export function titleOf(text: string, untitled: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return untitled;
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}
