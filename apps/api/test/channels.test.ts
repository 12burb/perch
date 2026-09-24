import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@perch/db";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { normalizeChannelName } from "../src/services/channels.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.1 (spec §5.2, §6, §7.1): channels as rooms — public, private, DMs and groups; who is in
 * them; what is unread; and archiving. Messages arrive in 2.2; what is proven here is that the
 * right people see the right rooms, that joining and leaving work, and that a private channel is
 * not even a name to somebody outside it.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ws = "";
let owner = { cookie: "", id: "" };
let member = { cookie: "", id: "" };
let outsider = { cookie: "", id: "" };

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

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

type ChannelBody = {
  id: string;
  type: string;
  name: string | null;
  topic: string | null;
  archived: boolean;
  member: boolean;
  unread: number;
  member_count: number;
};
type Listing = { body: { channels: ChannelBody[] } };
type Members = { body: { members: { member_id: string; name: string | null }[] } };

describe("channels (task 2.1)", () => {
  test("a name is what people type after a #", () => {
    expect(normalizeChannelName("  Release Notes ")).toBe("release-notes");
    expect(normalizeChannelName("Bug_Reports")).toBe("bug-reports");
    expect(normalizeChannelName("#general!!")).toBe("general");
    expect(() => normalizeChannelName("!!!")).toThrow();
    expect(() => normalizeChannelName("x".repeat(81))).toThrow();
  });

  test("public is for everybody, private is for the people in it", async () => {
    const stamp = Date.now();
    const robinEmail = `robin-chan-${stamp}@perch.test`;
    owner = await signUp("Wren", `wren-chan-${stamp}@perch.test`);
    member = await signUp("Robin", robinEmail);
    outsider = await signUp("Crow", `crow-chan-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Chat Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    // Robin joins the workspace; Crow never does.
    const invite = (await call(`/api/workspaces/${ws}/invites`, owner.cookie, {
      method: "POST",
      json: { email: robinEmail, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    const accepted = await call(`/api/invites/${token}/accept`, member.cookie, { method: "POST" });
    expect(accepted.status).toBe(200);

    const general = (await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "public", name: "General Talk", topic: "anything goes" },
    })) as { status: number; body: ChannelBody };
    expect(general.status).toBe(201);
    expect(general.body.name).toBe("general-talk");
    expect(general.body.member).toBe(true);
    expect(general.body.member_count).toBe(1);

    const secret = (await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "private", name: "Secrets" },
    })) as { status: number; body: ChannelBody };
    expect(secret.status).toBe(201);

    // The same name twice is a conflict, whatever case it is typed in.
    const again = await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "public", name: "general talk" },
    });
    expect(again.status).toBe(409);

    // Robin sees the public one and not the private one, and is in neither.
    const robinSees = (await call(`/api/workspaces/${ws}/channels`, member.cookie)) as Listing;
    expect(robinSees.body.channels.map((c) => c.name)).toEqual(["general-talk"]);
    expect(robinSees.body.channels[0]?.member).toBe(false);
    const peek = await call(`/api/workspaces/${ws}/channels/${secret.body.id}`, member.cookie);
    expect(peek.status).toBe(404);

    // Somebody outside the workspace is not told the workspace exists.
    const crowSees = await call(`/api/workspaces/${ws}/channels`, outsider.cookie);
    expect(crowSees.status).toBe(404);
  });

  test("join, leave, and be added", async () => {
    const listing = (await call(`/api/workspaces/${ws}/channels`, member.cookie)) as Listing;
    const general = listing.body.channels[0];
    if (!general) throw new Error("no channel to join");

    const joined = (await call(
      `/api/workspaces/${ws}/channels/${general.id}/members`,
      member.cookie,
      { method: "POST", json: {} },
    )) as { status: number; body: Members["body"] };
    expect(joined.status).toBe(200);
    expect(joined.body.members.map((m) => m.member_id)).toContain(member.id);
    expect(joined.body.members.map((m) => m.name)).toContain("Robin");

    // Joining twice is the same membership, not a second row.
    const twice = (await call(
      `/api/workspaces/${ws}/channels/${general.id}/members`,
      member.cookie,
      {
        method: "POST",
        json: {},
      },
    )) as { body: Members["body"] };
    expect(twice.body.members.filter((m) => m.member_id === member.id)).toHaveLength(1);

    const after = (await call(`/api/workspaces/${ws}/channels`, member.cookie)) as Listing;
    expect(after.body.channels[0]?.member).toBe(true);
    expect(after.body.channels[0]?.member_count).toBe(2);

    // Leaving puts it back the way it was.
    const left = await call(
      `/api/workspaces/${ws}/channels/${general.id}/members/${member.id}`,
      member.cookie,
      { method: "DELETE" },
    );
    expect(left.status).toBe(204);
    const gone = (await call(`/api/workspaces/${ws}/channels`, member.cookie)) as Listing;
    expect(gone.body.channels[0]?.member).toBe(false);

    // The owner adds Robin from the inside, which is how a private channel fills up.
    const secret = (await call(`/api/workspaces/${ws}/channels`, owner.cookie)) as Listing;
    const privateOne = secret.body.channels.find((c) => c.type === "private");
    if (!privateOne) throw new Error("no private channel");
    const added = await call(
      `/api/workspaces/${ws}/channels/${privateOne.id}/members`,
      owner.cookie,
      { method: "POST", json: { user_id: member.id } },
    );
    expect(added.status).toBe(200);
    const robinNowSees = (await call(`/api/workspaces/${ws}/channels`, member.cookie)) as Listing;
    expect(robinNowSees.body.channels.map((c) => c.name)).toContain("secrets");

    // Somebody who is not in the workspace cannot be put in one of its channels, by adding them
    // or by naming them when the channel is made (spec §9.1 scoping).
    const stranger = await signUp("Tern", `tern-channels-${Date.now()}@perch.test`);
    const smuggled = await call(
      `/api/workspaces/${ws}/channels/${privateOne.id}/members`,
      owner.cookie,
      { method: "POST", json: { user_id: stranger.id } },
    );
    expect(smuggled.status).toBe(404);
    const withStranger = await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "private", name: "with-a-stranger", members: [stranger.id] },
    });
    expect(withStranger.status).toBe(404);
    const still = (await call(`/api/workspaces/${ws}/channels`, stranger.cookie)) as {
      status: number;
    };
    expect(still.status).toBe(404);
  });

  test("unread is what arrived since you last read, and never your own", async () => {
    const listing = (await call(`/api/workspaces/${ws}/channels`, owner.cookie)) as Listing;
    const general = listing.body.channels.find((c) => c.name === "general-talk");
    if (!general) throw new Error("no channel");
    await call(`/api/workspaces/${ws}/channels/${general.id}/members`, member.cookie, {
      method: "POST",
      json: {},
    });

    // Messages arrive in task 2.2; the rows are what the count is made of, so they go in directly.
    const db = booted.db.db;
    const rows = await db
      .insert(schema.messages)
      .values([
        {
          workspaceId: ws,
          channelId: general.id,
          authorType: "user" as const,
          authorId: member.id,
          blocks: [{ type: "text" as const, text: "first" }],
        },
        {
          workspaceId: ws,
          channelId: general.id,
          authorType: "user" as const,
          authorId: member.id,
          blocks: [{ type: "text" as const, text: "second" }],
        },
        {
          workspaceId: ws,
          channelId: general.id,
          authorType: "user" as const,
          authorId: owner.id,
          blocks: [{ type: "text" as const, text: "mine" }],
        },
      ])
      .returning();
    expect(rows).toHaveLength(3);

    // Two of Robin's, and never the owner's own.
    const unread = (await call(`/api/workspaces/${ws}/channels`, owner.cookie)) as Listing;
    expect(unread.body.channels.find((c) => c.id === general.id)?.unread).toBe(2);

    // Read up to the first: one left.
    const first = rows[0];
    if (!first) throw new Error("no message");
    await db
      .insert(schema.readState)
      .values({ userId: owner.id, channelId: general.id, lastReadMessageId: first.id });
    const partly = (await call(`/api/workspaces/${ws}/channels`, owner.cookie)) as Listing;
    expect(partly.body.channels.find((c) => c.id === general.id)?.unread).toBe(1);
  });

  test("a topic is a member's to set; archiving belongs to the admins", async () => {
    const listing = (await call(`/api/workspaces/${ws}/channels`, owner.cookie)) as Listing;
    const general = listing.body.channels.find((c) => c.name === "general-talk");
    if (!general) throw new Error("no channel");

    const topic = (await call(`/api/workspaces/${ws}/channels/${general.id}`, member.cookie, {
      method: "PATCH",
      json: { topic: "release week" },
    })) as { status: number; body: ChannelBody };
    expect(topic.status).toBe(200);
    expect(topic.body.topic).toBe("release week");

    // Robin leaves first, so the join below is a real one: somebody in the workspace, outside
    // the channel, who could join it if it were not archived (X-test-07).
    const left = await call(
      `/api/workspaces/${ws}/channels/${general.id}/members/${member.id}`,
      member.cookie,
      { method: "DELETE" },
    );
    expect(left.status).toBe(204);

    // A member may not archive; the owner may, and it stays visible with a mark on it.
    const refused = await call(`/api/workspaces/${ws}/channels/${general.id}`, member.cookie, {
      method: "PATCH",
      json: { archived: true },
    });
    expect(refused.status).toBe(403);
    const archived = (await call(`/api/workspaces/${ws}/channels/${general.id}`, owner.cookie, {
      method: "PATCH",
      json: { archived: true },
    })) as { status: number; body: ChannelBody };
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);

    // Nobody joins an archive, not even a member of the workspace the channel is open to.
    const joinAttempt = await call(
      `/api/workspaces/${ws}/channels/${general.id}/members`,
      member.cookie,
      { method: "POST", json: {} },
    );
    expect(joinAttempt.status).toBe(409);

    // And it comes back out, open to joining again.
    const back = (await call(`/api/workspaces/${ws}/channels/${general.id}`, owner.cookie, {
      method: "PATCH",
      json: { archived: false },
    })) as { body: ChannelBody };
    expect(back.body.archived).toBe(false);
    const rejoined = await call(
      `/api/workspaces/${ws}/channels/${general.id}/members`,
      member.cookie,
      { method: "POST", json: {} },
    );
    expect(rejoined.status).toBe(200);
  });

  test("a project a channel names is one of this workspace's (A-rt-19)", async () => {
    // An id that names nothing is not found — not a foreign-key failure answered as a 500.
    const nowhere = await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "public", name: "linked-to-nothing", project_id: crypto.randomUUID() },
    });
    expect(nowhere.status).toBe(404);

    // Another workspace's project is not a link this workspace can make.
    const elsewhere = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Other Nest" },
    })) as { body: { id: string } };
    const theirs = (await call(`/api/workspaces/${elsewhere.body.id}/projects`, owner.cookie, {
      method: "POST",
      json: { name: "Theirs", key: "THEIRS" },
    })) as { status: number; body: { id: string } };
    expect(theirs.status).toBe(201);
    const foreign = await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "public", name: "linked-elsewhere", project_id: theirs.body.id },
    });
    expect(foreign.status).toBe(404);

    // This workspace's own project links as it always did.
    const ours = (await call(`/api/workspaces/${ws}/projects`, owner.cookie, {
      method: "POST",
      json: { name: "Ours", key: "OURS" },
    })) as { status: number; body: { id: string } };
    expect(ours.status).toBe(201);
    const linked = (await call(`/api/workspaces/${ws}/channels`, owner.cookie, {
      method: "POST",
      json: { type: "public", name: "ours-talk", project_id: ours.body.id },
    })) as { status: number; body: { project_id: string | null } };
    expect(linked.status).toBe(201);
    expect(linked.body.project_id).toBe(ours.body.id);
  });
});
