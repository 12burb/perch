import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { identifiersIn } from "../src/services/unfurl.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.3 (spec §1 "an identifier … that unfurls when pasted", §5.2): what a Perch identifier
 * turns into. The grammar, the cards, and the rule that matters — a card is a read, so nothing
 * unfurls for somebody who could not have opened it.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ws = "";
let slug = "";
let publicChannel = "";
let privateChannel = "";
let wren = { cookie: "", id: "" };
let robin = { cookie: "", id: "" };

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

type Card = {
  identifier: string;
  kind: string;
  title: string;
  subtitle: string | null;
  url: string;
};

const ask = (cookie: string, identifiers: string[]) =>
  call(`/api/workspaces/${ws}/unfurl`, cookie, {
    method: "POST",
    json: { identifiers },
  }) as Promise<{ status: number; body: { cards: Card[] } }>;

describe("unfurls (task 2.3)", () => {
  test("the grammar: kinds, deep links, and what is not an identifier", () => {
    expect(identifiersIn("look at session:8f2c and project:NEST")).toEqual([
      { identifier: "session:8f2c", kind: "session", ref: "8f2c" },
      { identifier: "project:NEST", kind: "project", ref: "NEST" },
    ]);
    expect(identifiersIn("perch://channel/general is the room")).toEqual([
      { identifier: "channel:general", kind: "channel", ref: "general" },
    ]);
    // The same one twice is one card, and an unknown kind is not an identifier at all.
    expect(identifiersIn("session:abc session:abc pr:42 https://x.test/a:b")).toEqual([
      { identifier: "session:abc", kind: "session", ref: "abc" },
    ]);
  });

  test("a channel, a project and a message unfurl for the people who can see them", async () => {
    const stamp = Date.now();
    wren = await signUp("Wren", `wren-unfurl-${stamp}@perch.test`);
    robin = await signUp("Robin", `robin-unfurl-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", wren.cookie, {
      method: "POST",
      json: { name: "Unfurl Nest" },
    })) as { body: { id: string; slug: string } };
    ws = made.body.id;
    slug = made.body.slug;
    const invite = (await call(`/api/workspaces/${ws}/invites`, wren.cookie, {
      method: "POST",
      json: { email: `robin-unfurl-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, robin.cookie, { method: "POST" })).status,
    ).toBe(200);

    const open = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "public", name: "general", topic: "everything" },
    })) as { body: { id: string } };
    publicChannel = open.body.id;
    const shut = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "private", name: "founders" },
    })) as { body: { id: string } };
    privateChannel = shut.body.id;

    const project = (await call(`/api/workspaces/${ws}/projects`, wren.cookie, {
      method: "POST",
      json: { name: "The Nest", key: "NEST" },
    })) as { status: number; body: { id: string; key: string } };
    expect(project.status).toBe(201);

    const said = (await call(
      `/api/workspaces/${ws}/channels/${publicChannel}/messages`,
      wren.cookie,
      { method: "POST", json: { text: "starting on project:NEST in channel:general" } },
    )) as { body: { id: string } };

    const cards = await ask(wren.cookie, [
      "starting on project:NEST in channel:general",
      `message:${said.body.id}`,
    ]);
    expect(cards.status).toBe(200);
    expect(cards.body.cards.map((card) => card.kind)).toEqual(["project", "channel", "message"]);
    // `project:NEST` and `project:nest` are the same project: the key column is citext.
    expect(cards.body.cards[0]).toMatchObject({
      identifier: "project:NEST",
      title: "The Nest",
      subtitle: "nest",
      url: `/${slug}/code/${project.body.id}`,
    });
    expect(cards.body.cards[1]).toMatchObject({
      title: "#general",
      subtitle: "everything",
      url: `/${slug}/home/${publicChannel}`,
    });
    expect(cards.body.cards[2]).toMatchObject({
      kind: "message",
      title: "Wren",
      subtitle: "starting on project:NEST in channel:general",
    });
  }, 60_000);

  test("a private channel unfurls for the people in it and for nobody else", async () => {
    const asWren = await ask(wren.cookie, ["channel:founders"]);
    expect(asWren.body.cards).toHaveLength(1);
    expect(asWren.body.cards[0]).toMatchObject({ kind: "channel", title: "#founders" });

    // Robin is in the workspace but not in that channel: there is nothing to unfurl.
    const asRobin = await ask(robin.cookie, ["channel:founders", `channel:${privateChannel}`]);
    expect(asRobin.body.cards).toEqual([]);

    // And the public one still unfurls for them.
    const open = await ask(robin.cookie, ["channel:general"]);
    expect(open.body.cards).toHaveLength(1);
  }, 30_000);

  test("an identifier from another workspace is not a card", async () => {
    const theirs = (await call("/api/workspaces", robin.cookie, {
      method: "POST",
      json: { name: "Robin Nest" },
    })) as { body: { id: string } };
    const theirChannel = (await call(`/api/workspaces/${theirs.body.id}/channels`, robin.cookie, {
      method: "POST",
      json: { type: "public", name: "somewhere-else" },
    })) as { body: { id: string } };
    const asked = await ask(robin.cookie, [`channel:${theirChannel.body.id}`]);
    expect(asked.body.cards).toEqual([]);
  }, 30_000);
});
