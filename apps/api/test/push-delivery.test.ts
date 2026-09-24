import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { silentLogger } from "../src/logging.ts";
import type { FetchLike } from "../src/net/outbound.ts";
import { startPushSubscriber } from "../src/push/subscriber.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { deliver, subscribe } from "../src/services/push.ts";
import { bootTestApp } from "../src/testing.ts";
import { subscribeAsBrowser, type UserAgent } from "./fixtures/push.ts";

/**
 * A push service that never answers (ADR-0173): delivery gives up at its deadline, and the message
 * that set the push off is posted without waiting for it — the push subscriber works detached
 * from the bus event, and stopping it abandons what is still waiting.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ua: UserAgent;

/** A push service that takes the request and never answers, until the request is abandoned. */
const silent: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

beforeAll(async () => {
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  ua = await subscribeAsBrowser();
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
  const me = (await call("/api/me", cookie)) as { body: { id: string; handle: string } };
  return { cookie, id: me.body.id, handle: me.body.handle };
}

describe("push delivery that does not answer (ADR-0173)", () => {
  test("one device's push service is given up on at the deadline", async () => {
    const who = await signUp("Kit", `kit-push-${Date.now()}@perch.test`);
    const deps = {
      db: booted.db,
      vault: booted.vault,
      env: { publicUrl: booted.env.publicUrl, outboundAllowPrivate: true },
    };
    const row = await subscribe(deps, {
      userId: who.id,
      endpoint: "http://127.0.0.1:9/push/never",
      p256dh: ua.subscription.p256dh,
      auth: ua.subscription.auth,
    });
    const started = Date.now();
    const result = await deliver(deps, row, { title: "t", body: "b", url: "/" }, silent, {
      timeoutMs: 100,
    });
    expect(result).toEqual({ ok: false, status: 0, gone: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  test("a mention is posted without waiting on the push it sets off", async () => {
    const stamp = Date.now();
    const wren = await signUp("Wren", `wren-slow-${stamp}@perch.test`);
    const robin = await signUp("Robin", `robin-slow-${stamp}@perch.test`);
    const ws = (
      (await call("/api/workspaces", wren.cookie, {
        method: "POST",
        json: { name: "Slow Nest" },
      })) as { body: { id: string } }
    ).body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, wren.cookie, {
      method: "POST",
      json: { email: `robin-slow-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    await call(`/api/invites/${token}/accept`, robin.cookie, { method: "POST" });
    const channel = (
      (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
        method: "POST",
        json: { type: "public", name: "general" },
      })) as { body: { id: string } }
    ).body.id;
    await call(`/api/workspaces/${ws}/channels/${channel}/members`, robin.cookie, {
      method: "POST",
      json: {},
    });
    const subscribed = await call("/api/me/push-subscriptions", robin.cookie, {
      method: "POST",
      json: { endpoint: "http://127.0.0.1:9/push/robin", keys: ua.subscription },
    });
    expect(subscribed.status).toBe(201);

    // A second push subscriber whose push service never answers, on the app's own bus.
    let asked = 0;
    const counting: FetchLike = (url, init) => {
      asked += 1;
      return silent(url, init);
    };
    const stop = startPushSubscriber({
      bus: booted.bus,
      db: booted.db,
      vault: booted.vault,
      env: { publicUrl: booted.env.publicUrl, outboundAllowPrivate: true },
      log: silentLogger(),
      fetcher: counting,
    });
    try {
      const started = Date.now();
      const said = await call(`/api/workspaces/${ws}/channels/${channel}/messages`, wren.cookie, {
        method: "POST",
        json: { text: `over to you <@${robin.handle}>` },
      });
      expect(said.status).toBe(201);
      expect(Date.now() - started).toBeLessThan(5_000);
      // The push did go out — it is just not what the message waited on.
      const deadline = Date.now() + 10_000;
      while (asked === 0 && Date.now() < deadline) await Bun.sleep(25);
      expect(asked).toBe(1);
    } finally {
      // Stopping abandons the push still waiting, so shutdown does not wait on it either.
      const stopping = Date.now();
      stop();
      await stop.settled();
      expect(Date.now() - stopping).toBeLessThan(5_000);
    }
  }, 60_000);
});
