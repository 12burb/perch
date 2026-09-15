/**
 * A mention on a phone (task 2.3; spec §5.2 "web push", §9.1 "every state change emits a bus event;
 * WS fan-out, inbox, webhooks and audit subscribe").
 *
 * Push subscribes the same way: it watches `message.created`, works out who was named, and sends
 * each of them one notification per device. Nothing here changes what a message is — a feature that
 * wanted notifications would otherwise have to know about phones, and this is the seam that keeps
 * it from having to.
 */
import type { Bus, Unsubscribe } from "@perch/bus";
import type { Db } from "@perch/db";
import { schema } from "@perch/db";
import type { Vault } from "@perch/vault";
import { eq } from "drizzle-orm";
import type { Logger } from "../logging.ts";
import { findMember, getChannel } from "../repos/channels.ts";
import { getMessage, usersByHandle } from "../repos/messages.ts";
import { mentionedHandles } from "../services/messages.ts";
import { notify, type PushMessage } from "../services/push.ts";

const { users, workspaces } = schema;

export type PushSubscriberDeps = {
  bus: Bus;
  db: { db: Db };
  vault: Vault;
  env: { publicUrl: string };
  log: Logger;
  /** Overridable so a test can be the push service. */
  fetcher?: typeof fetch;
};

/** The first line of what was said, which is all a notification has room for. */
function preview(blocks: { type: string }[]): string {
  const said = blocks
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join(" ")
    .replace(/<@([a-z0-9._-]+)>/gi, "@$1")
    .replace(/<#([a-z0-9._-]+)>/gi, "#$1")
    .trim();
  return said.length > 140 ? `${said.slice(0, 137)}…` : said;
}

export function startPushSubscriber(deps: PushSubscriberDeps): Unsubscribe {
  return deps.bus.subscribe("message.created", async (event) => {
    const payload = event.payload;
    try {
      const message = await getMessage(deps.db.db, payload.messageId);
      if (!message) return;
      const handles = mentionedHandles(message.blocks);
      if (handles.length === 0) return;
      const channel = await getChannel(deps.db.db, message.channelId);
      if (!channel) return;

      const [author] =
        message.authorType === "user"
          ? await deps.db.db
              .select({ name: users.name })
              .from(users)
              .where(eq(users.id, message.authorId))
              .limit(1)
          : [];
      const [workspace] = await deps.db.db
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.id, message.workspaceId))
        .limit(1);

      const note: PushMessage = {
        title: `${author?.name ?? "Someone"} in #${channel.name ?? "a channel"}`,
        body: preview(message.blocks),
        url: `/${workspace?.slug ?? message.workspaceId}/home/${channel.id}`,
        // One notification per channel: ten mentions in a row replace each other on the phone.
        tag: `channel:${channel.id}`,
      };

      for (const person of await usersByHandle(deps.db.db, handles)) {
        // Naming yourself is not a notification, and neither is naming somebody who is not here.
        if (person.id === message.authorId) continue;
        if (!(await findMember(deps.db.db, channel.id, "user", person.id))) continue;
        await notify(
          { db: deps.db, vault: deps.vault, env: deps.env },
          person.id,
          note,
          deps.fetcher ?? fetch,
        );
      }
    } catch (error) {
      // A push that fails is a notification somebody misses, never a message that fails to send.
      deps.log.warn({ err: error, messageId: payload.messageId }, "push for a mention failed");
    }
  });
}
