/**
 * Unfurls for Perch identifiers (spec §1 "every object has a stable URL, a `perch://` deep link,
 * and an identifier … that unfurls when pasted"; §5.2; task 2.3).
 *
 * An identifier is a kind and a reference — `session:8f2c…`, `project:NEST`, `channel:general`,
 * `message:<id>` — and a `perch://` link is the same thing said longhand. Resolving one is a read
 * like any other: the card comes back only when the caller could have opened the thing itself, and
 * a reference to something in another workspace resolves to nothing at all.
 */
import type { Channel, Db } from "@perch/db";
import { schema } from "@perch/db";
import { and, eq, sql } from "drizzle-orm";
import { findChannelByName, memberChannelIds } from "../repos/channels.ts";
import { getMessage } from "../repos/messages.ts";
import { findProject, findProjectByKey } from "../repos/projects.ts";
import { getSession } from "../repos/sessions.ts";

const { codingSessions, workspaces, users } = schema;

export const UNFURL_KINDS = ["session", "project", "channel", "message"] as const;
export type UnfurlKind = (typeof UNFURL_KINDS)[number];

export type UnfurlCard = {
  /** Exactly what was written, so the client can put the card beside it. */
  identifier: string;
  kind: UnfurlKind;
  title: string;
  subtitle: string | null;
  /** Where the thing lives in this Perch, as a path. */
  url: string;
};

/** The grammar, kept in step with `identifiersIn` in the web app's transcript. */
const IDENTIFIER =
  /(?:^|[\s(<])(session|project|channel|message):([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g;
const DEEP_LINK = /perch:\/\/(session|project|channel|message)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g;

export type Identifier = { identifier: string; kind: UnfurlKind; ref: string };

/** Every identifier in a piece of text, in the order it was written, without repeats. */
export function identifiersIn(text: string): Identifier[] {
  const out: Identifier[] = [];
  const seen = new Set<string>();
  for (const pattern of [IDENTIFIER, DEEP_LINK]) {
    for (const match of text.matchAll(pattern)) {
      const kind = (match[1] ?? "").toLowerCase() as UnfurlKind;
      const ref = match[2] ?? "";
      if (!UNFURL_KINDS.includes(kind) || !ref) continue;
      const identifier = `${kind}:${ref}`;
      if (seen.has(identifier)) continue;
      seen.add(identifier);
      out.push({ identifier, kind, ref });
    }
  }
  return out;
}

/** As many identifiers as one request may ask about: a message is not a crawl budget. */
export const MAX_IDENTIFIERS = 20;

export type UnfurlDeps = { db: { db: Db } };

type Who = { workspaceId: string; userId: string };

/**
 * A session is named by its id or by enough of it to be unmistakable — the "session:8f2" of the
 * spec. Eight characters of a UUIDv7 inside one workspace is not a collision anybody will meet.
 */
async function sessionCard(
  deps: UnfurlDeps,
  who: Who,
  found: Identifier,
): Promise<UnfurlCard | null> {
  const ref = found.ref.toLowerCase();
  const session =
    ref.length === 36
      ? await getSession(deps.db.db, ref)
      : ((
          await deps.db.db
            .select()
            .from(codingSessions)
            .where(
              and(
                eq(codingSessions.workspaceId, who.workspaceId),
                sql`${codingSessions.id}::text like ${sql.param(`${ref}%`, codingSessions.title)}`,
              ),
            )
            .limit(2)
        )[0] ?? null);
  if (!session || session.workspaceId !== who.workspaceId) return null;
  const slug = await slugOf(deps, who.workspaceId);
  return {
    identifier: found.identifier,
    kind: "session",
    title: session.title ?? `Session ${session.id.slice(0, 8)}`,
    subtitle: `${session.engine} · ${session.status}`,
    url: `/${slug}/code/${session.projectId}?session=${session.id}`,
  };
}

async function projectCard(
  deps: UnfurlDeps,
  who: Who,
  found: Identifier,
): Promise<UnfurlCard | null> {
  const project =
    found.ref.length === 36
      ? await findProject(deps.db.db, who.workspaceId, found.ref)
      : // `key` is citext, so NEST and nest are the same project (spec §6).
        await findProjectByKey(deps.db.db, who.workspaceId, found.ref);
  if (!project) return null;
  const slug = await slugOf(deps, who.workspaceId);
  return {
    identifier: found.identifier,
    kind: "project",
    title: project.name,
    subtitle: project.key,
    url: `/${slug}/code/${project.id}`,
  };
}

async function channelById(
  deps: UnfurlDeps,
  workspaceId: string,
  id: string,
): Promise<Channel | null> {
  const [row] = await deps.db.db
    .select()
    .from(schema.channels)
    .where(and(eq(schema.channels.id, id), eq(schema.channels.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** A channel unfurls only for somebody who could have found it: public, or one they are in. */
async function channelCard(
  deps: UnfurlDeps,
  who: Who,
  found: Identifier,
): Promise<UnfurlCard | null> {
  const channel: Channel | null =
    found.ref.length === 36
      ? await channelById(deps, who.workspaceId, found.ref)
      : await findChannelByName(deps.db.db, who.workspaceId, found.ref);
  if (!channel) return null;
  if (channel.type !== "public") {
    const mine = await memberChannelIds(deps.db.db, who.userId);
    if (!mine.includes(channel.id)) return null;
  }
  const slug = await slugOf(deps, who.workspaceId);
  return {
    identifier: found.identifier,
    kind: "channel",
    title: `#${channel.name ?? ""}`,
    subtitle: channel.topic,
    url: `/${slug}/home/${channel.id}`,
  };
}

/** A message unfurls as who said it and the first of what they said, in a channel you can see. */
async function messageCard(
  deps: UnfurlDeps,
  who: Who,
  found: Identifier,
): Promise<UnfurlCard | null> {
  if (found.ref.length !== 36) return null;
  const message = await getMessage(deps.db.db, found.ref);
  if (!message || message.workspaceId !== who.workspaceId || message.deletedAt) return null;
  const card = await channelCard(deps, who, {
    identifier: found.identifier,
    kind: "channel",
    ref: message.channelId,
  });
  if (!card) return null;
  const [author] =
    message.authorType === "user"
      ? await deps.db.db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, message.authorId))
          .limit(1)
      : [];
  const said = message.blocks
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join(" ")
    .trim();
  return {
    identifier: found.identifier,
    kind: "message",
    title: author?.name ?? "Someone",
    subtitle: said.length > 140 ? `${said.slice(0, 137)}…` : said || card.title,
    url: card.url,
  };
}

/** Asked every time rather than remembered: a workspace can be renamed between two messages. */
async function slugOf(deps: UnfurlDeps, workspaceId: string): Promise<string> {
  const [row] = await deps.db.db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.slug ?? workspaceId;
}

/** Cards for the identifiers a caller may see; anything else is simply absent. */
export async function unfurl(
  deps: UnfurlDeps,
  who: Who,
  identifiers: string[],
): Promise<UnfurlCard[]> {
  const cards: UnfurlCard[] = [];
  const asked = identifiers.slice(0, MAX_IDENTIFIERS).flatMap((raw) => identifiersIn(raw));
  for (const found of asked) {
    const card =
      found.kind === "session"
        ? await sessionCard(deps, who, found)
        : found.kind === "project"
          ? await projectCard(deps, who, found)
          : found.kind === "channel"
            ? await channelCard(deps, who, found)
            : await messageCard(deps, who, found);
    if (card) cards.push(card);
  }
  return cards;
}
