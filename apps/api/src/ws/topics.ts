/**
 * Topic authorization for /api/ws (spec §7.2): ws:<workspace> needs a membership, channel:<id> needs
 * the channel's workspace (and the channel itself when private), inbox:<user> is the caller's own,
 * session:<id> needs a membership in the session's workspace (task 1.8).
 */
import { type Db, schema } from "@perch/db";
import { and, eq } from "drizzle-orm";
import { getSession } from "../repos/sessions.ts";
import { findMembership } from "../repos/workspaces.ts";

const { channels, channelMembers } = schema;

export type TopicKind = "ws" | "channel" | "session" | "inbox";

export type ParsedTopic = { kind: TopicKind; id: string; topic: string };

export function parseTopic(topic: string): ParsedTopic | null {
  const match = /^(ws|channel|session|inbox):([A-Za-z0-9_-]+)$/.exec(topic);
  if (!match) return null;
  return { kind: match[1] as TopicKind, id: match[2] ?? "", topic };
}

export type TopicGrant =
  | { allowed: true; workspaceId: string | null }
  | { allowed: false; code: "not_found" | "forbidden" | "validation"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authorizeTopic(
  db: Db,
  userId: string,
  parsed: ParsedTopic,
): Promise<TopicGrant> {
  switch (parsed.kind) {
    case "ws": {
      if (!UUID.test(parsed.id)) return { allowed: false, code: "validation", message: "bad id" };
      const membership = await findMembership(db, parsed.id, userId);
      if (!membership) return { allowed: false, code: "not_found", message: "workspace not found" };
      return { allowed: true, workspaceId: parsed.id };
    }
    case "inbox": {
      if (parsed.id !== userId) {
        return { allowed: false, code: "forbidden", message: "inbox topics are personal" };
      }
      return { allowed: true, workspaceId: null };
    }
    case "channel": {
      if (!UUID.test(parsed.id)) return { allowed: false, code: "validation", message: "bad id" };
      const channel = await findChannel(db, parsed.id);
      if (!channel) return { allowed: false, code: "not_found", message: "channel not found" };
      const membership = await findMembership(db, channel.workspaceId, userId);
      if (!membership) return { allowed: false, code: "not_found", message: "channel not found" };
      if (channel.type !== "public" && !(await isChannelMember(db, channel.id, userId))) {
        return { allowed: false, code: "not_found", message: "channel not found" };
      }
      return { allowed: true, workspaceId: channel.workspaceId };
    }
    case "session": {
      if (!UUID.test(parsed.id)) return { allowed: false, code: "validation", message: "bad id" };
      const session = await getSession(db, parsed.id);
      if (!session) return { allowed: false, code: "not_found", message: "session not found" };
      const membership = await findMembership(db, session.workspaceId, userId);
      if (!membership) return { allowed: false, code: "not_found", message: "session not found" };
      return { allowed: true, workspaceId: session.workspaceId };
    }
  }
}

export async function findChannel(db: Db, id: string) {
  const [row] = await db
    .select({ id: channels.id, workspaceId: channels.workspaceId, type: channels.type })
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);
  return row ?? null;
}

export async function isChannelMember(db: Db, channelId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, "user"),
        eq(channelMembers.memberId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}
