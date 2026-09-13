import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@perch/db";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 0.10 (spec §7.2) against a real Bun.serve: subscribe with authorization, presence between two
 * connections of different users, resume with seq replaying missed events, typing, and rejections.
 */

let booted: Booted;
let running: RunningServer;
let base = "";

type Envelope = {
  type: string;
  topic: string;
  seq: number;
  ts: string;
  payload: Record<string, unknown>;
};

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
  const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as {
    id: string;
  };
  return { cookie, id: me.id };
}

async function rest<T>(
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return (await res.json()) as T;
}

class Client {
  readonly received: Envelope[] = [];
  private waiters: Array<{ match: (e: Envelope) => boolean; resolve: (e: Envelope) => void }> = [];
  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(String(event.data)) as Envelope;
      this.received.push(envelope);
      const index = this.waiters.findIndex((w) => w.match(envelope));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(envelope);
      }
    });
  }
  static async connect(cookie: string): Promise<Client> {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/ws`, { headers: { cookie } });
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws failed to open")));
    });
    return client;
  }
  send(op: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(op));
  }
  next(match: (e: Envelope) => boolean, timeoutMs = 5000): Promise<Envelope> {
    const already = this.received.find(match);
    if (already) {
      this.received.splice(this.received.indexOf(already), 1);
      return Promise.resolve(already);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const seen = this.received.map((e) => `${e.type}@${e.topic}`).join(", ") || "(none)";
        reject(new Error(`timed out waiting for envelope; received so far: ${seen}`));
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (e) => {
          clearTimeout(timer);
          this.received.splice(this.received.indexOf(e), 1);
          resolve(e);
        },
      });
    });
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.addEventListener("close", () => resolve());
      this.socket.close();
    });
  }
}

beforeAll(async () => {
  booted = await bootTestApp();
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
}, 30_000);

describe("/api/ws (task 0.10)", () => {
  let dawn: { cookie: string; id: string };
  let julius: { cookie: string; id: string };
  let paige: { cookie: string; id: string };
  let nest = "";

  test("setup: a workspace with two members and an outsider", async () => {
    dawn = await signUp("Dawn", "dawn@example.test");
    julius = await signUp("Julius", "julius@example.test");
    paige = await signUp("Paige", "paige@example.test");
    nest = (
      await rest<{ id: string }>("/api/workspaces", dawn.cookie, {
        method: "POST",
        json: { name: "Nest" },
      })
    ).id;
    const invite = await rest<{ accept_url: string }>(
      `/api/workspaces/${nest}/invites`,
      dawn.cookie,
      {
        method: "POST",
        json: { email: "julius@example.test" },
      },
    );
    const token = invite.accept_url.split("/invite/")[1] ?? "";
    await rest(`/api/invites/${token}/accept`, julius.cookie, { method: "POST" });
  });

  test("an unauthenticated upgrade is refused with the §7.8 forbidden body", async () => {
    const res = await fetch(`${base}/api/ws`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  });

  test("hello, subscribe with authorization, presence between two users, presence snapshot for a late joiner", async () => {
    const a = await Client.connect(dawn.cookie);
    const hello = await a.next((e) => e.type === "hello");
    expect(hello.payload.userId).toBe(dawn.id);
    expect(hello.payload.replayBuffer).toBe(1000);

    // A malformed topic fails the whole op (schema validation); an outsider's topic is hidden as
    // not_found; another user's inbox is forbidden; the own inbox is fine.
    a.send({ op: "subscribe", topics: ["nope"] });
    const malformed = await a.next((e) => e.type === "error");
    expect(malformed.payload).toMatchObject({ code: "validation", op: "subscribe" });
    a.send({ op: "subscribe", topics: [`ws:${nest}`, `inbox:${dawn.id}`, `inbox:${julius.id}`] });
    const subscribed = await a.next((e) => e.type === "subscribed" && e.topic === `ws:${nest}`);
    expect(subscribed.seq).toBeGreaterThan(0); // member.added events already happened on this topic
    const snapshot = await a.next((e) => e.type === "presence_snapshot");
    expect(snapshot.payload).toEqual({ workspaceId: nest, users: [] });
    await a.next((e) => e.type === "subscribed" && e.topic === `inbox:${dawn.id}`);
    const foreignInbox = await a.next(
      (e) => e.type === "error" && e.topic === `inbox:${julius.id}`,
    );
    expect(foreignInbox.payload.code).toBe("forbidden");

    const outsider = await Client.connect(paige.cookie);
    await outsider.next((e) => e.type === "hello");
    outsider.send({ op: "subscribe", topics: [`ws:${nest}`] });
    expect((await outsider.next((e) => e.type === "error")).payload.code).toBe("not_found");
    await outsider.close();

    a.send({ op: "presence", status: "online" });
    const b = await Client.connect(julius.cookie);
    await b.next((e) => e.type === "hello");
    b.send({ op: "subscribe", topics: [`ws:${nest}`] });
    const late = await b.next((e) => e.type === "presence_snapshot");
    expect(late.payload.users).toEqual([{ userId: dawn.id, status: "online" }]);
    b.send({ op: "presence", status: "online" });
    const seenByA = await a.next(
      (e) => e.type === "presence.changed" && e.payload.userId === julius.id,
    );
    expect(seenByA.payload).toEqual({ workspaceId: nest, userId: julius.id, status: "online" });
    expect(seenByA.topic).toBe(`ws:${nest}`);

    // A second tab for Julius: no duplicate "online"; closing one tab keeps him online; closing both → offline.
    const b2 = await Client.connect(julius.cookie);
    await b2.next((e) => e.type === "hello");
    b2.send({ op: "subscribe", topics: [`ws:${nest}`] });
    await b2.next((e) => e.type === "presence_snapshot");
    b2.send({ op: "presence", status: "online" });
    b2.send({ op: "ping", ts: 1 });
    await b2.next((e) => e.type === "pong");
    await b2.close();
    a.send({ op: "ping", ts: 2 });
    await a.next((e) => e.type === "pong" && e.payload.ts === 2);
    expect(
      a.received.filter((e) => e.type === "presence.changed" && e.payload.userId === julius.id),
    ).toHaveLength(0);
    await b.close();
    const offline = await a.next(
      (e) => e.type === "presence.changed" && e.payload.userId === julius.id,
    );
    expect(offline.payload.status).toBe("offline");
    await a.close();
  }, 20_000);

  test("reconnect replays: resume {topic, after_seq} delivers the missed events in order, and a gap asks for a resync", async () => {
    const a = await Client.connect(dawn.cookie);
    await a.next((e) => e.type === "hello");
    a.send({ op: "subscribe", topics: [`ws:${nest}`] });
    const sub = await a.next((e) => e.type === "subscribed" && e.topic === `ws:${nest}`);
    const lastSeen = sub.seq;
    await a.close(); // the "tab" goes away

    for (const name of ["Nest 1", "Nest 2", "Nest 3"]) {
      await rest(`/api/workspaces/${nest}`, dawn.cookie, { method: "PATCH", json: { name } });
    }

    const again = await Client.connect(dawn.cookie);
    await again.next((e) => e.type === "hello");
    again.send({ op: "subscribe", topics: [`ws:${nest}`] });
    await again.next((e) => e.type === "subscribed" && e.topic === `ws:${nest}`);
    again.send({ op: "resume", topic: `ws:${nest}`, after_seq: lastSeen });
    // Every event on the topic since lastSeen comes back in order: the three updates and the
    // audit.logged rows the audit subscriber published for them (spec §7.7), then the confirmation.
    const done = await again.next((e) => e.type === "subscribed" && e.payload.resumed === true);
    // Control envelopes (hello, subscribed, presence_snapshot) carry no dot; events do.
    const replayed = again.received.filter((e) => e.seq > lastSeen && e.type.includes("."));
    const latest = booted.bus.seq(`ws:${nest}`);
    expect(replayed.map((e) => e.seq)).toEqual(
      Array.from({ length: latest - lastSeen }, (_, i) => lastSeen + 1 + i),
    );
    expect(replayed.filter((e) => e.type === "workspace.updated")).toHaveLength(3);
    expect(replayed.filter((e) => e.type === "audit.logged")).toHaveLength(3);
    expect(done.payload.replayed).toBe(latest - lastSeen);
    expect(done.seq).toBe(latest);

    // Resuming before subscribing is an error; a seq older than the buffer is a resync.
    again.send({ op: "resume", topic: `ws:${Bun.randomUUIDv7()}`, after_seq: 0 });
    expect((await again.next((e) => e.type === "error")).payload.op).toBe("resume");
    for (let i = 0; i < 1005; i++) {
      await booted.bus.publish("workspace.updated", { workspaceId: nest, changes: ["settings"] });
    }
    again.send({ op: "resume", topic: `ws:${nest}`, after_seq: lastSeen });
    const resync = await again.next((e) => e.type === "resync");
    expect(resync.payload.latest).toBe(booted.bus.seq(`ws:${nest}`));
    expect(resync.payload.oldest).toBeGreaterThan(lastSeen + 1);
    await again.close();
  }, 30_000);

  test("typing fans out on the channel topic to members only, rate limited per channel", async () => {
    const [channel] = await booted.db.db
      .insert(schema.channels)
      .values({ workspaceId: nest, type: "public", name: "general" })
      .returning();
    const [secret] = await booted.db.db
      .insert(schema.channels)
      .values({ workspaceId: nest, type: "private", name: "secret" })
      .returning();
    if (!channel || !secret) throw new Error("channel insert failed");
    await booted.db.db
      .insert(schema.channelMembers)
      .values({ channelId: secret.id, memberType: "user", memberId: dawn.id });

    const a = await Client.connect(dawn.cookie);
    const b = await Client.connect(julius.cookie);
    await a.next((e) => e.type === "hello");
    await b.next((e) => e.type === "hello");
    b.send({ op: "subscribe", topics: [`channel:${channel.id}`, `channel:${secret.id}`] });
    await b.next((e) => e.type === "subscribed" && e.topic === `channel:${channel.id}`);
    expect(
      (await b.next((e) => e.type === "error" && e.topic === `channel:${secret.id}`)).payload.code,
    ).toBe("not_found");

    a.send({ op: "typing", channelId: channel.id });
    a.send({ op: "typing", channelId: channel.id }); // within the interval: dropped
    const seen = await b.next((e) => e.type === "typing");
    expect(seen.topic).toBe(`channel:${channel.id}`);
    expect(seen.payload).toEqual({
      workspaceId: nest,
      channelId: channel.id,
      memberType: "user",
      memberId: dawn.id,
    });
    a.send({ op: "ping" });
    await a.next((e) => e.type === "pong");
    expect(b.received.filter((e) => e.type === "typing")).toHaveLength(0);

    // Julius is not in the private channel: typing there is refused.
    b.send({ op: "typing", channelId: secret.id });
    expect(
      (await b.next((e) => e.type === "error" && e.payload.op === "typing")).payload.code,
    ).toBe("not_found");
    await a.close();
    await b.close();
  });
});
