import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";
import { decryptPush, subscribeAsBrowser, type UserAgent } from "./fixtures/push.ts";

/**
 * Task 2.3, the acceptance: a mention reaches a phone. A stand-in push service stands where
 * Google's or Mozilla's would, a browser subscribes against it, and the whole path runs — mention,
 * bus event, encryption, POST — with the test decrypting what arrives as the browser would.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let pushService: ReturnType<typeof Bun.serve> | null = null;
let ws = "";
let channel = "";
let wren = { cookie: "", id: "", handle: "" };
let robin = { cookie: "", id: "", handle: "" };
let ua: UserAgent;

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };
const sent: Sent[] = [];
/** What the stand-in answers next, so a retired subscription can be tested too. */
let answerWith = 201;

beforeAll(async () => {
  pushService = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      sent.push({
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return new Response(null, { status: answerWith });
    },
  });
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  ua = await subscribeAsBrowser();
}, 60_000);

afterAll(async () => {
  await running.stop();
  pushService?.stop(true);
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
  const me = (await call("/api/me", cookie)) as { body: { id: string; handle: string } };
  return { cookie, id: me.body.id, handle: me.body.handle };
}

/** The subscriber works off the bus, so the test waits for the push rather than assuming it. */
async function untilPushed(count: number): Promise<Sent> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const last = sent[count - 1];
    if (sent.length >= count && last) return last;
    await Bun.sleep(50);
  }
  throw new Error(`no push arrived (${sent.length} of ${count})`);
}

describe("web push (task 2.3)", () => {
  test("a mention arrives on the phone, encrypted to that device alone", async () => {
    const stamp = Date.now();
    wren = await signUp("Wren", `wren-push-${stamp}@perch.test`);
    robin = await signUp("Robin", `robin-push-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", wren.cookie, {
      method: "POST",
      json: { name: "Push Nest" },
    })) as { body: { id: string; slug: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, wren.cookie, {
      method: "POST",
      json: { email: `robin-push-${stamp}@perch.test`, role: "member" },
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
    await call(`/api/workspaces/${ws}/channels/${channel}/members`, robin.cookie, {
      method: "POST",
      json: {},
    });

    // The browser asks for the key, then subscribes with it. Perch makes the pair on first ask.
    const key = (await call("/api/me/push-key", robin.cookie)) as {
      status: number;
      body: { public_key: string };
    };
    expect(key.status).toBe(200);
    expect(key.body.public_key.length).toBeGreaterThan(80);
    const again = (await call("/api/me/push-key", wren.cookie)) as { body: { public_key: string } };
    expect(again.body.public_key).toBe(key.body.public_key);

    const endpoint = `${pushService?.url.href}push/robin`;
    const subscribed = await call("/api/me/push-subscriptions", robin.cookie, {
      method: "POST",
      json: { endpoint, keys: ua.subscription },
    });
    expect(subscribed.status).toBe(201);

    // Wren names Robin in a channel they are both in.
    const said = await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { text: `over to you <@${robin.handle}>` },
    });
    expect(said.status).toBe(201);

    const push = await untilPushed(1);
    expect(push.url).toBe(endpoint);
    expect(push.headers["content-encoding"]).toBe("aes128gcm");
    expect(push.headers.ttl).toBe(String(12 * 60 * 60));
    expect(push.headers.authorization).toStartWith("vapid t=");
    expect(push.headers.authorization).toContain(`k=${key.body.public_key}`);

    const note = JSON.parse(await decryptPush(push.body, ua)) as {
      title: string;
      body: string;
      url: string;
      tag: string;
    };
    expect(note.title).toBe("Wren in #general");
    expect(note.body).toBe(`over to you @${robin.handle}`);
    expect(note.url).toBe(`/${made.body.slug}/home/${channel}`);
    expect(note.tag).toBe(`channel:${channel}`);
  }, 60_000);

  test("nothing is pushed for a message that names nobody, or names the person who wrote it", async () => {
    const before = sent.length;
    await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { text: "just thinking out loud" },
    });
    await call(`/api/workspaces/${ws}/channels/${channel}/messages`, robin.cookie, {
      method: "POST",
      json: { text: `talking to myself <@${robin.handle}>` },
    });
    // Both messages have gone through the bus by the time a third, mentioning push arrives.
    await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { text: `still here <@${robin.handle}>` },
    });
    const push = await untilPushed(before + 1);
    const note = JSON.parse(await decryptPush(push.body, ua)) as { body: string };
    expect(note.body).toBe(`still here @${robin.handle}`);
    expect(sent).toHaveLength(before + 1);
  }, 60_000);

  test("a push service that says the device is gone retires the subscription", async () => {
    answerWith = 410;
    const before = sent.length;
    await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { text: `are you there <@${robin.handle}>` },
    });
    await untilPushed(before + 1);
    answerWith = 201;

    // The subscription is not offered again, and nothing more is sent to it.
    const listed = (await call("/api/me/push-subscriptions", robin.cookie)) as {
      body: { subscriptions: unknown[] };
    };
    expect(listed.body.subscriptions).toEqual([]);
    const after = sent.length;
    await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
      method: "POST",
      json: { text: `hello again <@${robin.handle}>` },
    });
    await Bun.sleep(500);
    expect(sent).toHaveLength(after);
  }, 60_000);

  test("unsubscribing is the device's own, and only its own", async () => {
    const endpoint = `${pushService?.url.href}push/wren`;
    expect(
      (
        await call("/api/me/push-subscriptions", wren.cookie, {
          method: "POST",
          json: { endpoint, keys: ua.subscription },
        })
      ).status,
    ).toBe(201);
    // Robin cannot remove Wren's device: the endpoint is matched against their own rows.
    expect(
      (
        await call("/api/me/push-subscriptions", robin.cookie, {
          method: "DELETE",
          json: { endpoint },
        })
      ).status,
    ).toBe(204);
    const stillThere = (await call("/api/me/push-subscriptions", wren.cookie)) as {
      body: { subscriptions: { endpoint: string }[] };
    };
    expect(stillThere.body.subscriptions.map((row) => row.endpoint)).toEqual([endpoint]);

    expect(
      (
        await call("/api/me/push-subscriptions", wren.cookie, {
          method: "DELETE",
          json: { endpoint },
        })
      ).status,
    ).toBe(204);
    const gone = (await call("/api/me/push-subscriptions", wren.cookie)) as {
      body: { subscriptions: unknown[] };
    };
    expect(gone.body.subscriptions).toEqual([]);
  }, 60_000);
});
