import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ed25519Keypair, parseManifest, signDelivery } from "@perch/connect";
import { MANIFESTS } from "@perch/connectors";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.4 (spec §3.5 "inbound webhooks at /hooks/:provider/:id with signature verification →
 * channel cards").
 *
 * The acceptance is the second test: a signed GitHub push posts a card in the channel it was wired
 * to, and an unsigned one is refused. The rest is what makes that endpoint safe to leave open —
 * the only unauthenticated write in Perch.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let ws = "";
let cookie = "";
let channelId = "";
let hookId = "";
let secret = "";

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
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as unknown };
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A delivery, the way GitHub sends one. */
async function deliver(
  body: string,
  options: { signature?: string; delivery?: string; event?: string; id?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.signature !== "") {
    headers["x-hub-signature-256"] = options.signature ?? (await sign(body));
  }
  if (options.delivery !== "") headers["x-github-delivery"] = options.delivery ?? "d-1";
  headers["x-github-event"] = options.event ?? "push";
  const res = await fetch(`${base}/hooks/github/${options.id ?? hookId}`, {
    method: "POST",
    headers,
    body,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as { status?: string } };
}

type Id = { id: string };
type MessageRow = {
  id: string;
  author_type: string;
  blocks: { type: string; title?: string; provider?: string; event?: string; url?: string }[];
};

const PUSH = JSON.stringify({
  ref: "refs/heads/main",
  compare: "https://github.test/perch/nest/compare/aaa...bbb",
  pusher: { name: "ada" },
  repository: { full_name: "perch/nest" },
  commits: [
    { id: "bbb", message: "Teach the runner to wait" },
    { id: "ccc", message: "Tidy" },
  ],
});

describe("inbound webhooks (task 3.4)", () => {
  test("an admin makes an endpoint, and the secret is shown exactly once", async () => {
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Ada",
        email: `ada-hooks-${Date.now()}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signed.status).toBe(200);
    cookie = cookiesFrom(signed);
    ws = (
      (await call("/api/workspaces", { method: "POST", json: { name: "Nest" } })) as {
        body: Id;
      }
    ).body.id;
    channelId = (
      (await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { type: "public", name: "builds" },
      })) as { body: Id }
    ).body.id;

    const made = (await call(`/api/workspaces/${ws}/webhooks`, {
      method: "POST",
      json: { provider: "github", name: "Nest pushes", channel_id: channelId },
    })) as {
      status: number;
      body: { webhook: { id: string; url: string; deliveries: number }; secret: string };
    };
    expect(made.status).toBe(201);
    hookId = made.body.webhook.id;
    secret = made.body.secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(made.body.webhook.url).toContain(`/hooks/github/${hookId}`);

    // The list has the endpoint and never the secret.
    const listed = (await call(`/api/workspaces/${ws}/webhooks`)) as {
      text: string;
      body: { webhooks: { id: string; deliveries: number }[] };
    };
    expect(listed.body.webhooks).toHaveLength(1);
    expect(listed.text).not.toContain(secret);
    expect(listed.body.webhooks[0]?.deliveries).toBe(0);
  }, 60_000);

  test("a signed GitHub push posts a card; an unsigned one is refused", async () => {
    // Unsigned: nothing is posted and the provider is told plainly.
    const bare = await deliver(PUSH, { signature: "" });
    expect(bare.status).toBe(403);
    const wrong = await deliver(PUSH, { signature: "sha256=not-the-signature" });
    expect(wrong.status).toBe(403);

    // Signed: a card in the channel it was wired to.
    const ok = await deliver(PUSH);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("posted");

    const messages = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
      body: { messages: MessageRow[] };
    };
    const cards = messages.body.messages.filter((one) => one.blocks[0]?.type === "webhook_card");
    expect(cards).toHaveLength(1);
    const card = cards[0]?.blocks[0];
    expect(card?.provider).toBe("github");
    expect(card?.event).toBe("push");
    expect(card?.title).toBe("2 commits on main");
    expect(card?.url).toContain("compare");
  }, 60_000);

  test("the same delivery twice is one card", async () => {
    const again = await deliver(PUSH);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("duplicate");

    const messages = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
      body: { messages: MessageRow[] };
    };
    expect(
      messages.body.messages.filter((one) => one.blocks[0]?.type === "webhook_card"),
    ).toHaveLength(1);

    // A different delivery of the same body is news again: the provider says which is which.
    const next = await deliver(PUSH, { delivery: "d-2" });
    expect(next.body.status).toBe("posted");
    expect(
      (
        (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`)) as {
          body: { messages: MessageRow[] };
        }
      ).body.messages.filter((one) => one.blocks[0]?.type === "webhook_card"),
    ).toHaveLength(2);
  }, 60_000);

  test("an endpoint that is not here says so, whatever it was signed with", async () => {
    const nowhere = await deliver(PUSH, { id: crypto.randomUUID() });
    expect(nowhere.status).toBe(404);
    // The right id with the wrong provider is the same answer: this endpoint is not here.
    const res = await fetch(`${base}/hooks/vercel/${hookId}`, {
      method: "POST",
      headers: { "x-hub-signature-256": await sign(PUSH) },
      body: PUSH,
    });
    expect(res.status).toBe(404);
  }, 60_000);

  test("a connection an endpoint names is one this workspace has (A-rt-19)", async () => {
    // An id that names no connection here is not found, and nothing is made — not a foreign-key
    // failure answered as a 500.
    const before = (await call(`/api/workspaces/${ws}/webhooks`)) as {
      body: { webhooks: unknown[] };
    };
    const nowhere = await call(`/api/workspaces/${ws}/webhooks`, {
      method: "POST",
      json: {
        provider: "github",
        name: "Linked to nothing",
        channel_id: channelId,
        connection_id: crypto.randomUUID(),
      },
    });
    expect(nowhere.status).toBe(404);
    const after = (await call(`/api/workspaces/${ws}/webhooks`)) as {
      body: { webhooks: unknown[] };
    };
    expect(after.body.webhooks).toHaveLength(before.body.webhooks.length);
  }, 60_000);

  test("a provider that signs with its own key is set up the other way round (task 3.25)", async () => {
    const discord = parseManifest(MANIFESTS.discord ?? "");
    const keys = await ed25519Keypair();
    const make = async (json: Record<string, unknown>) =>
      await call(`/api/workspaces/${ws}/webhooks`, {
        method: "POST",
        json: { provider: "discord", name: "Guild", channel_id: channelId, ...json },
      });

    // Discord's key is Discord's: there is no secret for Perch to hand out, so it asks for theirs.
    expect((await make({})).status).toBe(422);
    expect((await make({ key: "not-a-key" })).status).toBe(422);
    // And a provider Perch does generate a secret for has no key to paste in.
    const confused = await call(`/api/workspaces/${ws}/webhooks`, {
      method: "POST",
      json: {
        provider: "github",
        name: "Confused",
        channel_id: channelId,
        key: keys.publicKey,
      },
    });
    expect(confused.status).toBe(422);

    const made = (await make({ key: keys.publicKey })) as {
      status: number;
      text: string;
      body: { webhook: { id: string; url: string }; secret: string | null };
    };
    expect(made.status).toBe(201);
    expect(made.body.secret).toBeNull();
    const id = made.body.webhook.id;
    expect(made.body.webhook.url).toContain(`/hooks/discord/${id}`);

    const body = JSON.stringify({ type: 1, guild_id: "1", t: "MESSAGE_CREATE" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const post = async (signature: string) =>
      await fetch(`${base}/hooks/discord/${id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp,
        },
        body,
      });

    const real = await signDelivery({
      manifest: discord,
      headers: { "x-signature-timestamp": timestamp },
      body,
      secret: keys.privateKey,
    });
    expect((await post(real)).status).toBe(200);

    // Somebody else's application, signing the same delivery, is not this one.
    const impostor = await ed25519Keypair();
    const forged = await signDelivery({
      manifest: discord,
      headers: { "x-signature-timestamp": timestamp },
      body,
      secret: impostor.privateKey,
    });
    expect((await post(forged)).status).toBe(403);

    expect((await call(`/api/workspaces/${ws}/webhooks/${id}`, { method: "DELETE" })).status).toBe(
      204,
    );
  }, 60_000);

  test("the endpoint counts what it took, and stops when it is taken away", async () => {
    const listed = (await call(`/api/workspaces/${ws}/webhooks`)) as {
      body: { webhooks: { deliveries: number; last_delivery_at: string | null }[] };
    };
    expect(listed.body.webhooks[0]?.deliveries).toBe(2);
    expect(listed.body.webhooks[0]?.last_delivery_at).not.toBeNull();

    const gone = await call(`/api/workspaces/${ws}/webhooks/${hookId}`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    const after = await deliver(PUSH, { delivery: "d-3" });
    expect(after.status).toBe(404);
  }, 60_000);
});
