import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Message, messageBlocksSchema, schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "../src/auth/authorize.ts";
import type { Booted } from "../src/boot.ts";
import { getChannel } from "../src/repos/channels.ts";
import { getMessage, updateMessageBlocks } from "../src/repos/messages.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { edit, mentionedHandles, parseBlocks, remove } from "../src/services/messages.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.2 (spec §5.2, §6, §7.1): what is said in a channel. Posting and paging, editing with the
 * history kept, deleting by the author and by an admin, threads with their reply counts, pins,
 * bookmarks, read state, and a mention that weighs on the channel it was said in.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ws = "";
let channel = "";
let wren = { cookie: "", id: "", handle: "" };
let robin = { cookie: "", id: "", handle: "" };

beforeAll(async () => {
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string; handle: string } };
  return { cookie, id: me.body.id, handle: me.body.handle };
}

type MessageBody = {
  id: string;
  thread_root_id: string | null;
  author_name: string | null;
  blocks: { type: string; text?: string }[];
  reply_count: number;
  pinned: boolean;
  bookmarked: boolean;
  edited_at: string | null;
  deleted_at: string | null;
};
type Listing = { status: number; body: { messages: MessageBody[] } };
type Channels = { body: { channels: { id: string; unread: number; mentions: number }[] } };

const say = (cookie: string, text: string, threadRootId?: string) =>
  call(`/api/workspaces/${ws}/channels/${channel}/messages`, cookie, {
    method: "POST",
    json: { text, ...(threadRootId ? { thread_root_id: threadRootId } : {}) },
  }) as Promise<{ status: number; body: MessageBody }>;

describe("messages (task 2.2)", () => {
  test("a mention is a handle in angle brackets", () => {
    expect(mentionedHandles([{ type: "text", text: "morning <@robin> and <@Wren>" }])).toEqual([
      "robin",
      "wren",
    ]);
    expect(
      mentionedHandles([{ type: "text", text: "an email@example.com is not a mention" }]),
    ).toEqual([]);
    expect(mentionedHandles([{ type: "code", code: "<@robin>" }])).toEqual([]);
  });

  test("say something, and read the channel back", async () => {
    const stamp = Date.now();
    wren = await signUp("Wren", `wren-msg-${stamp}@perch.test`);
    robin = await signUp("Robin", `robin-msg-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", wren.cookie, {
      method: "POST",
      json: { name: "Message Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, wren.cookie, {
      method: "POST",
      json: { email: `robin-msg-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, robin.cookie, { method: "POST" })).status,
    ).toBe(200);

    const created = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "public", name: "general" },
    })) as { body: { id: string } };
    channel = created.body.id;

    const first = await say(wren.cookie, "morning");
    expect(first.status).toBe(201);
    expect(first.body.blocks).toEqual([{ type: "text", text: "morning" }]);
    expect(first.body.author_name).toBe("Wren");

    // Robin is in the workspace but not in the channel: reading is fine, writing is not.
    const readable = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      robin.cookie,
    )) as Listing;
    expect(readable.status).toBe(200);
    expect(readable.body.messages).toHaveLength(1);
    const refused = await say(robin.cookie, "hello?");
    expect(refused.status).toBe(409);

    await call(`/api/workspaces/${ws}/channels/${channel}/members`, robin.cookie, {
      method: "POST",
      json: {},
    });
    const second = await say(robin.cookie, "morning yourself");
    expect(second.status).toBe(201);

    // Oldest first, and paging by id walks backwards from the newest.
    const all = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      wren.cookie,
    )) as Listing;
    expect(all.body.messages.map((m) => m.blocks[0]?.text)).toEqual([
      "morning",
      "morning yourself",
    ]);
    const older = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages?before=${second.body.id}`,
      wren.cookie,
    )) as Listing;
    expect(older.body.messages.map((m) => m.id)).toEqual([first.body.id]);
    const newer = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages?after=${first.body.id}`,
      wren.cookie,
    )) as Listing;
    expect(newer.body.messages.map((m) => m.id)).toEqual([second.body.id]);
  });

  test("editing keeps what it said before; only the author may", async () => {
    const posted = await say(wren.cookie, "a first draft");
    const edited = (await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, wren.cookie, {
      method: "PATCH",
      json: { text: "a second draft" },
    })) as { status: number; body: MessageBody };
    expect(edited.status).toBe(200);
    expect(edited.body.blocks[0]?.text).toBe("a second draft");
    expect(edited.body.edited_at).not.toBeNull();

    const history = (await call(
      `/api/workspaces/${ws}/messages/${posted.body.id}/edits`,
      wren.cookie,
    )) as { body: { edits: { blocks: { text?: string }[] }[] } };
    expect(history.body.edits).toHaveLength(1);
    expect(history.body.edits[0]?.blocks[0]?.text).toBe("a first draft");

    const notYours = await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, robin.cookie, {
      method: "PATCH",
      json: { text: "not yours to change" },
    });
    expect(notYours.status).toBe(403);
  });

  test("a thread hangs off a message and counts its replies", async () => {
    const root = await say(wren.cookie, "who is deploying today?");
    const reply = await say(robin.cookie, "me", root.body.id);
    expect(reply.status).toBe(201);
    expect(reply.body.thread_root_id).toBe(root.body.id);

    // A reply to a reply joins the same thread rather than starting one.
    const deeper = await say(wren.cookie, "thanks", reply.body.id);
    expect(deeper.body.thread_root_id).toBe(root.body.id);

    const thread = (await call(
      `/api/workspaces/${ws}/messages/${reply.body.id}/thread`,
      wren.cookie,
    )) as Listing;
    expect(thread.body.messages.map((m) => m.blocks[0]?.text)).toEqual([
      "who is deploying today?",
      "me",
      "thanks",
    ]);

    // The channel shows the root with its count, and not the replies themselves.
    const channelFlow = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      wren.cookie,
    )) as Listing;
    const shown = channelFlow.body.messages.find((m) => m.id === root.body.id);
    expect(shown?.reply_count).toBe(2);
    expect(channelFlow.body.messages.map((m) => m.blocks[0]?.text)).not.toContain("me");
  });

  test("pins belong to the channel, bookmarks to the person", async () => {
    const posted = await say(wren.cookie, "the runbook is here");
    const pinned = (await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, wren.cookie, {
      method: "PATCH",
      json: { pinned: true },
    })) as { body: MessageBody };
    expect(pinned.body.pinned).toBe(true);
    const pins = (await call(
      `/api/workspaces/${ws}/channels/${channel}/pins`,
      robin.cookie,
    )) as Listing;
    expect(pins.body.messages.map((m) => m.id)).toContain(posted.body.id);

    // A bookmark is one person's own.
    await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, robin.cookie, {
      method: "PATCH",
      json: { bookmarked: true },
    });
    const robinsLater = (await call(`/api/workspaces/${ws}/bookmarks`, robin.cookie)) as Listing;
    expect(robinsLater.body.messages.map((m) => m.id)).toContain(posted.body.id);
    const wrensLater = (await call(`/api/workspaces/${ws}/bookmarks`, wren.cookie)) as Listing;
    expect(wrensLater.body.messages.map((m) => m.id)).not.toContain(posted.body.id);

    const unpinned = (await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, robin.cookie, {
      method: "PATCH",
      json: { pinned: false },
    })) as { body: MessageBody };
    expect(unpinned.body.pinned).toBe(false);
  });

  test("a mention weighs on the channel, and reading clears what is unread", async () => {
    await say(wren.cookie, `over to you <@${robin.handle}>`);
    const weighed = (await call(`/api/workspaces/${ws}/channels`, robin.cookie)) as Channels;
    const row = weighed.body.channels.find((c) => c.id === channel);
    expect(row?.mentions).toBeGreaterThan(0);
    expect(row?.unread).toBeGreaterThan(0);

    const latest = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      robin.cookie,
    )) as Listing;
    const last = latest.body.messages.at(-1);
    if (!last) throw new Error("no messages");
    const marked = await call(`/api/workspaces/${ws}/channels/${channel}/read`, robin.cookie, {
      method: "POST",
      json: { message_id: last.id },
    });
    expect(marked.status).toBe(204);

    // A reply in a thread is not in the channel's flow, so it does not make the channel unread —
    // otherwise reading the channel could never clear it.
    const root = latest.body.messages[0];
    if (!root) throw new Error("no root");
    await say(wren.cookie, "one more thing", root.id);
    const quiet = (await call(`/api/workspaces/${ws}/channels`, robin.cookie)) as Channels;
    const after = quiet.body.channels.find((c) => c.id === channel);
    expect(after?.unread).toBe(0);
    expect(after?.mentions).toBe(0);
  });

  test("deleting is the author's, or an admin's", async () => {
    const mine = await say(robin.cookie, "never mind");
    const byAuthor = await call(`/api/workspaces/${ws}/messages/${mine.body.id}`, robin.cookie, {
      method: "DELETE",
    });
    expect(byAuthor.status).toBe(204);
    const flow = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages?limit=200`,
      robin.cookie,
    )) as Listing;
    const gone = flow.body.messages.find((m) => m.id === mine.body.id);
    expect(gone?.deleted_at).not.toBeNull();
    expect(gone?.blocks).toEqual([]);

    // Robin is a member, so somebody else's message is not theirs to take down; Wren owns the
    // workspace, so it is.
    const theirs = await say(wren.cookie, "still here");
    const refused = await call(`/api/workspaces/${ws}/messages/${theirs.body.id}`, robin.cookie, {
      method: "DELETE",
    });
    expect(refused.status).toBe(403);
    const moderated = await call(`/api/workspaces/${ws}/messages/${theirs.body.id}`, wren.cookie, {
      method: "DELETE",
    });
    expect(moderated.status).toBe(204);
  });

  test("bookmarks are this workspace's, in channels you can still open (A-rt-04, A-co-06)", async () => {
    const room = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "private", name: "finance", members: [robin.id] },
    })) as { status: number; body: { id: string } };
    expect(room.status).toBe(201);
    const said = (await call(
      `/api/workspaces/${ws}/channels/${room.body.id}/messages`,
      wren.cookie,
      {
        method: "POST",
        json: { text: "the quarter's numbers" },
      },
    )) as { status: number; body: MessageBody };
    expect(said.status).toBe(201);
    await call(`/api/workspaces/${ws}/messages/${said.body.id}`, robin.cookie, {
      method: "PATCH",
      json: { bookmarked: true },
    });
    const saved = (await call(`/api/workspaces/${ws}/bookmarks`, robin.cookie)) as Listing;
    expect(saved.body.messages.map((m) => m.id)).toContain(said.body.id);

    // Taken out of the channel, Robin's bookmark no longer opens it.
    const removed = await call(
      `/api/workspaces/${ws}/channels/${room.body.id}/members/${robin.id}`,
      wren.cookie,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    const after = (await call(`/api/workspaces/${ws}/bookmarks`, robin.cookie)) as Listing;
    expect(after.body.messages.map((m) => m.id)).not.toContain(said.body.id);
    // The public one saved earlier is still there.
    expect(after.body.messages.length).toBeGreaterThan(0);

    // The list is a page: newest first, as long as asked, and `before` turns it.
    const another = await say(wren.cookie, "worth keeping too");
    await call(`/api/workspaces/${ws}/messages/${another.body.id}`, robin.cookie, {
      method: "PATCH",
      json: { bookmarked: true },
    });
    const all = (await call(`/api/workspaces/${ws}/bookmarks`, robin.cookie)) as Listing;
    expect(all.body.messages.length).toBeGreaterThanOrEqual(2);
    const one = (await call(`/api/workspaces/${ws}/bookmarks?limit=1`, robin.cookie)) as Listing;
    expect(one.body.messages.map((m) => m.id)).toEqual([another.body.id]);
    const next = (await call(
      `/api/workspaces/${ws}/bookmarks?limit=1&before=${another.body.id}`,
      robin.cookie,
    )) as Listing;
    expect(next.body.messages.map((m) => m.id)).toEqual([all.body.messages[1]?.id ?? ""]);

    // Another workspace's path lists that workspace's bookmarks, which here is none.
    const elsewhere = (await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Robin's Own" },
    })) as { body: { id: string } };
    const theirs = (await call(
      `/api/workspaces/${elsewhere.body.id}/bookmarks`,
      robin.cookie,
    )) as Listing;
    expect(theirs.status).toBe(200);
    expect(theirs.body.messages).toEqual([]);
  });

  test("a deleted message keeps no history, and nothing writes it back (X-data-15)", async () => {
    const posted = await say(wren.cookie, "the key is k-1234");
    await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, wren.cookie, {
      method: "PATCH",
      json: { text: "the key is in the vault" },
    });
    const gone = await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, wren.cookie, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);

    const history = (await call(
      `/api/workspaces/${ws}/messages/${posted.body.id}/edits`,
      robin.cookie,
    )) as { status: number; body: { edits: unknown[] } };
    expect(history.status).toBe(200);
    expect(history.body.edits).toEqual([]);
    const kept = await booted.db.db
      .select()
      .from(schema.messageEdits)
      .where(eq(schema.messageEdits.messageId, posted.body.id));
    expect(kept).toHaveLength(0);

    // A rewrite that was already on its way — a bot's stream, a card moving — finds nothing to
    // write into, and says so rather than putting the words back.
    const row = await getMessage(booted.db.db, posted.body.id);
    if (!row) throw new Error("no row");
    const stale: Message = { ...row, deletedAt: null };
    const rewritten = await updateMessageBlocks(
      booted.db.db,
      stale,
      [{ type: "text", text: "the key is k-1234" }],
      { type: "bot", id: wren.id, history: false },
    );
    expect(rewritten).toBeNull();
    expect((await getMessage(booted.db.db, posted.body.id))?.blocks).toEqual([]);
  });

  test("two deletes of one reply take one off the count, and say so once (X-data-26)", async () => {
    const deps = { db: booted.db, bus: booted.bus };
    const room = await getChannel(booted.db.db, channel);
    if (!room) throw new Error("no channel");
    const root = await say(wren.cookie, "roll call");
    const first = await say(robin.cookie, "here", root.body.id);
    await say(wren.cookie, "here too", root.body.id);
    const snapshot = await getMessage(booted.db.db, first.body.id);
    if (!snapshot) throw new Error("no reply");

    const told: string[] = [];
    const stop = booted.bus.subscribe("message.deleted", (event) => {
      told.push(event.payload.messageId);
    });
    // The author and a moderator, both holding the copy they read before either delete landed.
    const byRobin: ActorContext = { actor: { type: "user", id: robin.id }, meta: {} };
    const byWren: ActorContext = { actor: { type: "user", id: wren.id }, meta: {} };
    await remove(deps, {
      channel: room,
      message: snapshot,
      userId: robin.id,
      canModerate: false,
      by: byRobin,
    });
    await remove(deps, {
      channel: room,
      message: snapshot,
      userId: wren.id,
      canModerate: true,
      by: byWren,
    });
    stop();
    expect((await getMessage(booted.db.db, root.body.id))?.replyCount).toBe(1);
    expect(told.filter((id) => id === first.body.id)).toHaveLength(1);
  });

  test("two edits from one stale copy keep every version (X-data-26)", async () => {
    const deps = { db: booted.db, bus: booted.bus };
    const room = await getChannel(booted.db.db, channel);
    if (!room) throw new Error("no channel");
    const posted = await say(wren.cookie, "version one");
    const snapshot = await getMessage(booted.db.db, posted.body.id);
    if (!snapshot) throw new Error("no message");
    const by: ActorContext = { actor: { type: "user", id: wren.id }, meta: {} };
    for (const text of ["version two", "version three"]) {
      await edit(deps, {
        channel: room,
        message: snapshot,
        userId: wren.id,
        blocks: [{ type: "text", text }],
        by,
      });
    }
    const history = (await call(
      `/api/workspaces/${ws}/messages/${posted.body.id}/edits`,
      wren.cookie,
    )) as { body: { edits: { blocks: { text?: string }[] }[] } };
    expect(history.body.edits.map((one) => one.blocks[0]?.text).sort()).toEqual([
      "version one",
      "version two",
    ]);
  });

  test("editing a message does not name anybody twice (X-data-25, A-sm-27)", async () => {
    const mentions = async () => {
      const listed = (await call(`/api/workspaces/${ws}/channels`, robin.cookie)) as Channels;
      return listed.body.channels.find((c) => c.id === channel)?.mentions ?? -1;
    };
    const before = await mentions();
    const posted = await say(wren.cookie, `<@${robin.handle}> can you look`);
    expect(await mentions()).toBe(before + 1);
    for (const text of [
      `<@${robin.handle}> can you look at this`,
      `<@${robin.handle}> could you look at this`,
    ]) {
      const edited = await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, wren.cookie, {
        method: "PATCH",
        json: { text },
      });
      expect(edited.status).toBe(200);
    }
    expect(await mentions()).toBe(before + 1);
  });

  test("an archived channel is a record: no edits, and only a moderator takes one down (A-sm-28)", async () => {
    const room = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "public", name: "incident" },
    })) as { body: { id: string } };
    await call(`/api/workspaces/${ws}/channels/${room.body.id}/members`, robin.cookie, {
      method: "POST",
      json: {},
    });
    const post = (text: string) =>
      call(`/api/workspaces/${ws}/channels/${room.body.id}/messages`, robin.cookie, {
        method: "POST",
        json: { text },
      }) as Promise<{ status: number; body: MessageBody }>;
    const first = await post("the database is down");
    const second = await post("it is back");
    const archived = await call(`/api/workspaces/${ws}/channels/${room.body.id}`, wren.cookie, {
      method: "PATCH",
      json: { archived: true },
    });
    expect(archived.status).toBe(200);

    const rewrite = await call(`/api/workspaces/${ws}/messages/${first.body.id}`, robin.cookie, {
      method: "PATCH",
      json: { text: "nothing happened" },
    });
    expect(rewrite.status).toBe(409);
    const takeDown = await call(`/api/workspaces/${ws}/messages/${first.body.id}`, robin.cookie, {
      method: "DELETE",
    });
    expect(takeDown.status).toBe(409);
    const moderated = await call(`/api/workspaces/${ws}/messages/${second.body.id}`, wren.cookie, {
      method: "DELETE",
    });
    expect(moderated.status).toBe(204);
  });

  test("a card Perch vouches for is Perch's to post (A-wr-06)", async () => {
    const raceId = crypto.randomUUID();
    const forged = await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { blocks: [{ type: "race_card", raceId, state: "running", entrants: [] }] },
    });
    expect(forged.status).toBe(422);
    const posted = await say(wren.cookie, "an ordinary line");
    const rewritten = await call(`/api/workspaces/${ws}/messages/${posted.body.id}`, wren.cookie, {
      method: "PATCH",
      json: {
        blocks: [
          { type: "session_card", sessionId: crypto.randomUUID(), url: "https://elsewhere.test" },
        ],
      },
    });
    expect(rewritten.status).toBe(422);

    // Each of these is a well-formed block — the schema takes it — and is refused for what it is.
    const id = crypto.randomUUID();
    const cards: Record<string, unknown>[] = [
      { type: "diff_card", sessionId: id },
      { type: "session_card", sessionId: id },
      { type: "webhook_card", provider: "github", event: "push", title: "3 commits" },
      {
        type: "deploy_card",
        provider: "vercel",
        deploymentId: "dpl_1",
        target: "preview",
        state: "ready",
      },
      { type: "race_card", raceId: id, state: "running", entrants: [] },
      { type: "preflight_card", state: "passed", verdict: "warn", rows: [] },
      { type: "background_card", sessionId: id, state: "running", prompt: "tidy up" },
      { type: "queue_card", branch: "fix", base: "main", state: "waiting", position: 1 },
      { type: "plan_card", steps: [] },
    ];
    for (const card of cards) {
      expect(messageBlocksSchema.safeParse([card]).success).toBe(true);
      expect(() => parseBlocks([card])).toThrow();
    }
    // What a person or a bot composes is still theirs to send.
    expect(
      parseBlocks([
        { type: "text", text: "Ship it?" },
        { type: "code", code: "bun test" },
        { type: "approve_deny", id: "ship", text: "Ship?", action: "ship" },
        { type: "progress", value: 0.5 },
      ]),
    ).toHaveLength(4);
  });
});
