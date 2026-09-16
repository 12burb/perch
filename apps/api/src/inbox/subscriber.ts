/**
 * The approval inbox (spec §5.7 "one queue for permission prompts, preflight results, PRs awaiting
 * review, budget alerts, failed bot runs, chain breakers, intake, mentions"; task 2.10).
 *
 * It subscribes to the bus like push and audit do (spec §9.1): nothing that asks a person for
 * something has to know the inbox exists. What the item says is written here, once, so the queue —
 * and the phone — read in a single query (ADR-0100).
 */
import type { Bus, Unsubscribe } from "@perch/bus";
import type { Db, InboxKind, InboxPayload } from "@perch/db";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Logger } from "../logging.ts";
import { getBot } from "../repos/bots.ts";
import { findMember, getChannel } from "../repos/channels.ts";
import { addItem, resolveRef } from "../repos/inbox.ts";
import { getMessage, usersByHandle } from "../repos/messages.ts";
import { getSession } from "../repos/sessions.ts";
import { mentionedHandles } from "../services/messages.ts";

const { users, workspaces } = schema;

export type InboxSubscriberDeps = {
  bus: Bus;
  db: { db: Db };
  log: Logger;
};

/** The first line of what was said, which is all an inbox row has room for. */
function preview(blocks: { type: string }[]): string {
  const said = blocks
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join(" ")
    .replace(/<@([a-z0-9._-]+)>/gi, "@$1")
    .replace(/<#([a-z0-9._-]+)>/gi, "#$1")
    .trim();
  return said.length > 200 ? `${said.slice(0, 197)}…` : said;
}

export function startInboxSubscriber(deps: InboxSubscriberDeps): Unsubscribe {
  const db = deps.db.db;

  /** Where in this Perch a person lands when they open an item. */
  const slugOf = async (workspaceId: string): Promise<string> => {
    const [row] = await db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return row?.slug ?? workspaceId;
  };

  const put = async (input: {
    workspaceId: string;
    userId: string;
    kind: InboxKind;
    refType: string;
    refId: string;
    payload: InboxPayload;
  }) => {
    const item = await addItem(db, input);
    await deps.bus.publish(
      "inbox.item_created",
      {
        workspaceId: input.workspaceId,
        userId: input.userId,
        inboxItemId: item.id,
        kind: input.kind,
      },
      // Personal: an item goes to its own inbox topic and nowhere a workspace can watch.
      { actor: { type: "system" }, topics: [`inbox:${input.userId}`] },
    );
  };

  const guard = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      // An inbox that fails is a row somebody does not see, never the thing that caused it.
      deps.log.warn({ err: error }, `inbox: ${what} failed`);
    }
  };

  const offs: Unsubscribe[] = [
    // An agent is waiting on a person (spec §5.7 "the phone gets what needs a human").
    deps.bus.subscribe("session.permission_requested", (event) =>
      guard("a permission", async () => {
        const { workspaceId, sessionId, permissionId, tool } = event.payload;
        const session = await getSession(db, sessionId);
        if (!session) return;
        const slug = await slugOf(workspaceId);
        await put({
          workspaceId,
          userId: session.userId,
          kind: "permission",
          refType: "session_permission",
          refId: `${sessionId}:${permissionId}`,
          payload: {
            title: session.title ?? "A session needs you",
            body: tool,
            url: `/${slug}/code?session=${sessionId}`,
          },
        });
      }),
    ),
    // Answered is done, wherever it was answered.
    deps.bus.subscribe("session.permission_answered", (event) =>
      guard("answering a permission", async () => {
        const { sessionId, permissionId } = event.payload;
        await resolveRef(db, {
          kind: "permission",
          refType: "session_permission",
          refId: `${sessionId}:${permissionId}`,
        });
      }),
    ),
    // A bot wants to use a connection a person has to say yes to (spec §3.5 "requires_permission
    // tools return pending + inbox item"; task 3.6). The one who asked the bot is the one asked.
    deps.bus.subscribe("bot.permission_requested", (event) =>
      guard("a bot's permission", async () => {
        const { workspaceId, botId, callId, channelId, tool, requestedBy } = event.payload;
        const bot = await getBot(db, botId);
        if (!bot) return;
        const channel = await getChannel(db, channelId);
        const slug = await slugOf(workspaceId);
        await put({
          workspaceId,
          // A schedule or a webhook set it off: then it is the bot's owner who answers for it.
          userId: requestedBy ?? bot.ownerId,
          kind: "permission",
          refType: "bot_tool_call",
          refId: callId,
          payload: {
            title: `${bot.name} wants to use ${tool}`,
            body: `in #${channel?.name ?? "a chat"}`,
            url: `/${slug}/home/${channelId}`,
          },
        });
      }),
    ),
    // Answered is done, wherever it was answered.
    deps.bus.subscribe("bot.permission_answered", (event) =>
      guard("answering a bot's permission", async () => {
        await resolveRef(db, {
          kind: "permission",
          refType: "bot_tool_call",
          refId: event.payload.callId,
        });
      }),
    ),
    // The rails paused a thread and want somebody to say whether it carries on (spec §5.4).
    deps.bus.subscribe("bot.chain_breaker", (event) =>
      guard("a chain breaker", async () => {
        const { workspaceId, threadRootId, reason } = event.payload;
        const root = await getMessage(db, threadRootId);
        if (root?.authorType !== "user") return;
        const channel = await getChannel(db, root.channelId);
        const slug = await slugOf(workspaceId);
        await put({
          workspaceId,
          userId: root.authorId,
          kind: "chain",
          refType: "thread",
          refId: threadRootId,
          payload: {
            title: `A thread in #${channel?.name ?? "a chat"} is paused`,
            body: reason,
            url: `/${slug}/home/${root.channelId}`,
          },
        });
      }),
    ),
    // Money, and a bot that could not answer: both are their owner's to deal with.
    deps.bus.subscribe("budget.exceeded", (event) =>
      guard("a budget", async () => {
        const { workspaceId, subjectType, subjectId, spentUsd, limitUsd } = event.payload;
        if (subjectType !== "bot") return;
        const bot = await getBot(db, subjectId);
        if (!bot) return;
        const slug = await slugOf(workspaceId);
        await put({
          workspaceId,
          userId: bot.ownerId,
          kind: "budget",
          refType: "bot",
          refId: bot.id,
          payload: {
            title: `@${bot.handle} has spent what it may today`,
            body: `$${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}`,
            url: `/${slug}/settings`,
          },
        });
      }),
    ),
    deps.bus.subscribe("bot.run_failed", (event) =>
      guard("a failed run", async () => {
        const { workspaceId, botId, runId, error } = event.payload;
        const bot = await getBot(db, botId);
        if (!bot) return;
        const slug = await slugOf(workspaceId);
        await put({
          workspaceId,
          userId: bot.ownerId,
          kind: "bot_failure",
          refType: "bot_run",
          refId: runId,
          payload: {
            title: `@${bot.handle} could not answer`,
            body: error,
            url: `/${slug}/settings`,
          },
        });
      }),
    ),
    // Being named is the one item a person puts there themselves, by talking (spec §5.2).
    deps.bus.subscribe("message.created", (event) =>
      guard("a mention", async () => {
        const { workspaceId, messageId } = event.payload;
        const message = await getMessage(db, messageId);
        if (!message) return;
        const handles = mentionedHandles(message.blocks);
        if (handles.length === 0) return;
        const channel = await getChannel(db, message.channelId);
        if (!channel) return;
        const [author] =
          message.authorType === "user"
            ? await db
                .select({ name: users.name })
                .from(users)
                .where(eq(users.id, message.authorId))
                .limit(1)
            : [];
        const said =
          message.authorType === "bot"
            ? ((await getBot(db, message.authorId))?.name ?? "A bot")
            : (author?.name ?? "Someone");
        const slug = await slugOf(workspaceId);
        for (const person of await usersByHandle(db, handles)) {
          if (person.id === message.authorId) continue;
          if (!(await findMember(db, channel.id, "user", person.id))) continue;
          await put({
            workspaceId,
            userId: person.id,
            kind: "mention",
            refType: "message",
            refId: message.id,
            payload: {
              title: `${said} named you in #${channel.name ?? "a chat"}`,
              body: preview(message.blocks),
              url: `/${slug}/home/${channel.id}`,
            },
          });
        }
      }),
    ),
  ];

  return () => {
    for (const off of offs) off();
  };
}
