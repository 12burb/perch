import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { parseEmoji } from "../src/services/messages.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.3 (spec §5.2, §6 message_reactions, §7.1, §7.7): an emoji on a message. Who may put one
 * there, what a second one from the same person does, what the pills look like when they come
 * back, and the `reaction.added` / `reaction.removed` the rest of the room hears.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ws = "";
let channel = "";
let wren = { cookie: "", id: "" };
let robin = { cookie: "", id: "" };
const heard: { type: string; emoji: string; memberId: string }[] = [];

beforeAll(async () => {
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  booted.bus.subscribe("reaction.added", (event) => {
    heard.push({ type: "added", emoji: event.payload.emoji, memberId: event.payload.memberId });
  });
  booted.bus.subscribe("reaction.removed", (event) => {
    heard.push({ type: "removed", emoji: event.payload.emoji, memberId: event.payload.memberId });
  });
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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string } };
  return { cookie, id: me.body.id };
}

type Pill = { emoji: string; count: number; mine: boolean };
type MessageBody = { id: string; reactions: Pill[]; deleted_at: string | null };
type Answer = { status: number; body: MessageBody };

const reactTo = (cookie: string, id: string, emoji: string) =>
  call(`/api/workspaces/${ws}/messages/${id}/reactions`, cookie, {
    method: "POST",
    json: { emoji },
  }) as Promise<Answer>;

const unreact = (cookie: string, id: string, emoji: string) =>
  call(`/api/workspaces/${ws}/messages/${id}/reactions/${encodeURIComponent(emoji)}`, cookie, {
    method: "DELETE",
  }) as Promise<Answer>;

describe("reactions (task 2.3)", () => {
  test("an emoji is a few code points and nothing else", () => {
    expect(parseEmoji("👀")).toBe("👀");
    expect(parseEmoji(" 🎉 ")).toBe("🎉");
    // A flag, a skin tone and a family are all one emoji made of several code points.
    expect(parseEmoji("👩‍👩‍👧‍👦")).toBe("👩‍👩‍👧‍👦");
    expect(() => parseEmoji("")).toThrow();
    expect(() => parseEmoji("a whole sentence, really")).toThrow();
    expect(() => parseEmoji("👀 👀")).toThrow();
    expect(() => parseEmoji(String.fromCharCode(7))).toThrow();
  });

  test("two people, one message: pills count, mine toggles, and the room is told", async () => {
    const stamp = Date.now();
    wren = await signUp("Wren", `wren-react-${stamp}@perch.test`);
    robin = await signUp("Robin", `robin-react-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", wren.cookie, {
      method: "POST",
      json: { name: "React Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, wren.cookie, {
      method: "POST",
      json: { email: `robin-react-${stamp}@perch.test`, role: "member" },
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

    const said = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { text: "shipping it" },
    })) as { body: MessageBody };
    expect(said.body.reactions).toEqual([]);

    // Robin is in the workspace but not in the channel: reacting is writing in it.
    const outside = await reactTo(robin.cookie, said.body.id, "👀");
    expect(outside.status).toBe(409);
    await call(`/api/workspaces/${ws}/channels/${channel}/members`, robin.cookie, {
      method: "POST",
      json: {},
    });

    const first = await reactTo(wren.cookie, said.body.id, "👀");
    expect(first.status).toBe(200);
    expect(first.body.reactions).toEqual([{ emoji: "👀", count: 1, mine: true }]);

    // The same emoji from somebody else is the same pill, one higher.
    const second = await reactTo(robin.cookie, said.body.id, "👀");
    expect(second.body.reactions).toEqual([{ emoji: "👀", count: 2, mine: true }]);

    // Reacting twice is the reaction you already had: no second row, and nobody is told again.
    const again = await reactTo(robin.cookie, said.body.id, "👀");
    expect(again.body.reactions).toEqual([{ emoji: "👀", count: 2, mine: true }]);
    expect(heard.filter((e) => e.type === "added")).toHaveLength(2);

    // A different emoji is a pill of its own, after the one that was there first.
    const party = await reactTo(robin.cookie, said.body.id, "🎉");
    expect(party.body.reactions).toEqual([
      { emoji: "👀", count: 2, mine: true },
      { emoji: "🎉", count: 1, mine: true },
    ]);

    // Wren sees Robin's 🎉 as somebody else's.
    const asWren = (await call(
      `/api/workspaces/${ws}/channels/${channel}/messages`,
      wren.cookie,
    )) as { body: { messages: MessageBody[] } };
    expect(asWren.body.messages[0]?.reactions).toEqual([
      { emoji: "👀", count: 2, mine: true },
      { emoji: "🎉", count: 1, mine: false },
    ]);

    // Taking yours off leaves everybody else's.
    const removed = await unreact(robin.cookie, said.body.id, "👀");
    expect(removed.body.reactions).toEqual([
      { emoji: "👀", count: 1, mine: false },
      { emoji: "🎉", count: 1, mine: true },
    ]);
    // Taking off one that was never there changes nothing and tells nobody.
    const noop = await unreact(robin.cookie, said.body.id, "🙈");
    expect(noop.status).toBe(200);
    expect(heard.filter((e) => e.type === "removed")).toHaveLength(1);

    // The last one off leaves no pill at all.
    await unreact(wren.cookie, said.body.id, "👀");
    const bare = await unreact(robin.cookie, said.body.id, "🎉");
    expect(bare.body.reactions).toEqual([]);
  }, 60_000);

  test("a message that is gone takes no reactions", async () => {
    const said = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { text: "never mind" },
    })) as { body: MessageBody };
    expect(
      (
        await call(`/api/workspaces/${ws}/messages/${said.body.id}`, wren.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    const refused = await reactTo(robin.cookie, said.body.id, "👀");
    expect(refused.status).toBe(409);
  }, 30_000);
});
