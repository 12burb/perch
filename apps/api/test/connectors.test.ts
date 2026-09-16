import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, signDelivery } from "@perch/connect";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { updateConnectionSecret } from "../src/repos/connections.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.11 (spec §5.5 "Everything else via manifests"): the acceptance is that a connector added
 * as a file alone connects, refreshes, and receives a webhook.
 *
 * So that is what this does. Acme is not in `@perch/connectors` and nothing in Perch has heard of
 * it: it is a manifest.yaml written into a directory at the start of the test, with
 * `PERCH_CONNECTORS_DIR` pointing at it, and a stand-in on this machine answering as the provider.
 * No code is added for it anywhere — that is the whole claim.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let dir = "";
let provider: ReturnType<typeof Bun.serve> | null = null;
let providerUrl = "";
let cookie = "";
let ws = "";
let channel = "";

/** Every token the stand-in has issued, newest last. */
const issued: string[] = [];
/** Every refresh it was asked for. */
const refreshes: { refreshToken: string; clientId: string }[] = [];

function manifestFor(url: string): string {
  return `# Acme, a connector that exists only as this file (task 3.11).
id: acme
name: Acme
summary: A provider nobody built anything for.
auth:
  - oauth2
  - token
api_base: ${url}
token_prefix:
  - acme_
test_path: /whoami
account_field: account
headers:
  X-Acme-Version: "2026-09-16"
oauth:
  authorize_url: ${url}/authorize
  token_url: ${url}/token
  scopes:
    - read
  scope_separator: " "
  refresh: true
webhook_signature: hmac_sha256
webhook:
  header: x-acme-signature
  prefix: "sha256="
  encoding: hex
  signed: "{timestamp}.{body}"
  id_header: x-acme-delivery
  event_header: x-acme-event
  timestamp_header: x-acme-timestamp
  tolerance_s: 300
`;
}

beforeAll(async () => {
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/whoami") {
        const auth = request.headers.get("authorization") ?? "";
        // The manifest's own header travels on every call Perch makes for this provider.
        if (request.headers.get("x-acme-version") !== "2026-09-16") {
          return Response.json({ message: "which version?" }, { status: 400 });
        }
        const token = auth.replace(/^Bearer /, "");
        if (!token || (issued.length > 0 && token !== issued.at(-1))) {
          return Response.json({ message: "no" }, { status: 401 });
        }
        return Response.json({ account: "acme-inc" });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        if (form.get("grant_type") !== "refresh_token") {
          return Response.json({ message: "not that grant" }, { status: 400 });
        }
        refreshes.push({
          refreshToken: form.get("refresh_token") ?? "",
          clientId: form.get("client_id") ?? "",
        });
        const fresh = `acme_fresh_${refreshes.length}`;
        issued.push(fresh);
        // No `refresh_token` in the answer: Acme does not rotate, which most providers do not, and
        // the one Perch already holds has to go on working.
        return Response.json({ access_token: fresh, expires_in: 3600, scope: "read" });
      }
      return Response.json({ message: "no" }, { status: 404 });
    },
  });
  providerUrl = `http://127.0.0.1:${provider.port}`;

  // The connector, as a file and nothing else.
  dir = mkdtempSync(join(tmpdir(), "perch-connectors-"));
  mkdirSync(join(dir, "acme"));
  writeFileSync(join(dir, "acme", "manifest.yaml"), manifestFor(providerUrl));

  booted = await bootTestApp({ PERCH_CONNECTORS_DIR: dir });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  provider?.stop(true);
  rmSync(dir, { recursive: true, force: true });
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

let connectionId = "";
let webhookId = "";
let webhookSecret = "";

describe("a connector that is only a file (task 3.11)", () => {
  test("Perch offers it, having only read it", async () => {
    const stamp = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Robin",
        email: `robin-acme-${stamp}@perch.test`,
        password: "correct horse battery staple",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = cookiesFrom(signUp);
    const made = (await call("/api/workspaces", {
      method: "POST",
      json: { name: "Acme Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const room = (await call(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      json: { type: "public", name: "alerts" },
    })) as { body: { id: string } };
    channel = room.body.id;

    const providers = (await call(`/api/workspaces/${ws}/connection-providers`)) as {
      status: number;
      body: { providers: { id: string; name: string; lanes: string[] }[] };
    };
    expect(providers.status).toBe(200);
    const acme = providers.body.providers.find((one) => one.id === "acme");
    expect(acme).toMatchObject({ name: "Acme", api_base: providerUrl });
    // Both lanes the file offers, in the order §3.5 puts them: strongest identity first.
    expect(acme?.lanes).toEqual(["oauth2", "token"]);
  }, 60_000);

  test("it connects: a pasted token is checked against the provider the manifest names", async () => {
    issued.push("acme_pasted_1");
    const connected = (await call(`/api/workspaces/${ws}/connections`, {
      method: "POST",
      json: { kind: "token", provider: "acme", owner_type: "workspace", token: "acme_pasted_1" },
    })) as { status: number; text: string; body: { id: string; account: string | null } };
    expect(connected.status, connected.text).toBe(201);
    // The account came back from the stand-in, through `account_field` and the manifest's header.
    expect(connected.body.account).toBe("acme-inc");
    connectionId = connected.body.id;

    // A token that is not the one it issued is refused, so the check is a real call.
    const wrong = await call(`/api/workspaces/${ws}/connections`, {
      method: "POST",
      json: { kind: "token", provider: "acme", token: "acme_not_this_one" },
    });
    expect(wrong.status).toBe(502);
  }, 60_000);

  test("it refreshes: an expiring token is swapped before it is used", async () => {
    // The workspace's own Acme app, registered the way §3.5's pre-registered lane wants it. An
    // oauth2 connection has one behind it, and the refresh is made with it.
    const app = await call(`/api/workspaces/${ws}/oauth-clients`, {
      method: "POST",
      json: { provider: "acme", client_id: "acme-client-1", client_secret: "acme-secret-1" },
    });
    expect(app.status, app.text).toBe(201);

    // An oauth2 connection a minute from expiry, the way one looks after an hour of use. Written
    // straight to the row because the authorization dance is task 2.14's and not what this checks.
    const secret = await booted.vault.encrypt(
      JSON.stringify({ access: "acme_stale", refresh: "acme_refresh_1" }),
      `connection:${ws}`,
    );
    const rows = (await call(`/api/workspaces/${ws}/connections`)) as {
      body: { connections: { id: string }[] };
    };
    expect(rows.body.connections.some((one) => one.id === connectionId)).toBe(true);
    await booted.db.db
      .update(schema.connections)
      .set({ kind: "oauth2" })
      .where(eq(schema.connections.id, connectionId));
    await updateConnectionSecret(booted.db.db, connectionId, {
      ciphertext: secret,
      expiresAt: new Date(Date.now() + 5_000),
    });

    // Testing the connection uses it, which is when a refresh happens.
    const tested = (await call(`/api/workspaces/${ws}/connections/${connectionId}/test`, {
      method: "POST",
    })) as { status: number; text: string; body: { account: string | null } };
    expect(tested.status, tested.text).toBe(200);
    expect(tested.body.account).toBe("acme-inc");

    // It really refreshed: the provider was asked, with the refresh token Perch held.
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.refreshToken).toBe("acme_refresh_1");
    expect(refreshes[0]?.clientId).toBe("acme-client-1");
    // And the new token is what the next call carries — the stand-in refuses anything else.
    expect(issued.at(-1)).toBe("acme_fresh_1");
    const again = (await call(`/api/workspaces/${ws}/connections/${connectionId}/test`, {
      method: "POST",
    })) as { status: number };
    expect(again.status).toBe(200);
    // Once, not every time: the fresh token has an hour on it.
    expect(refreshes).toHaveLength(1);

    // And it can do it twice. Acme answers a refresh without a new refresh token — which is what
    // most providers do — so the second one only works if Perch kept the one it had.
    await booted.db.db
      .update(schema.connections)
      .set({ expiresAt: new Date(Date.now() + 5_000) })
      .where(eq(schema.connections.id, connectionId));
    const third = (await call(`/api/workspaces/${ws}/connections/${connectionId}/test`, {
      method: "POST",
    })) as { status: number; text: string };
    expect(third.status, third.text).toBe(200);
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]?.refreshToken).toBe("acme_refresh_1");
  }, 60_000);

  test("it receives a webhook: signed the way the file says, and posted as a card", async () => {
    const made = (await call(`/api/workspaces/${ws}/webhooks`, {
      method: "POST",
      json: { provider: "acme", name: "Acme alerts", channel_id: channel },
    })) as { status: number; text: string; body: { webhook: { id: string }; secret: string } };
    expect(made.status, made.text).toBe(201);
    webhookId = made.body.webhook.id;
    webhookSecret = made.body.secret;
    expect(webhookSecret).toMatch(/\S/);

    const manifest = parseManifest(manifestFor(providerUrl));
    const body = JSON.stringify({ what: "a thing happened" });
    const headers = new Headers({
      "content-type": "application/json",
      "x-acme-delivery": "delivery-1",
      "x-acme-event": "thing.happened",
      "x-acme-timestamp": String(Math.floor(Date.now() / 1000)),
    });
    headers.set(
      "x-acme-signature",
      await signDelivery({ manifest, headers, body, secret: webhookSecret }),
    );

    const post = () => fetch(`${base}/hooks/acme/${webhookId}`, { method: "POST", headers, body });
    const delivered = await post();
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ ok: true, status: "posted" });

    // The same delivery again is the same delivery: `id_header` came from the file, so Perch knows
    // which one it is without anything having been written for Acme.
    expect(await (await post()).json()).toMatchObject({ status: "duplicate" });

    // The card is in the channel, titled from the event header the manifest names.
    const messages = (await call(`/api/workspaces/${ws}/channels/${channel}/messages`)) as {
      body: { messages: { blocks: { type: string; event?: string; provider?: string }[] }[] };
    };
    const card = messages.body.messages
      .flatMap((one) => one.blocks)
      .find((one) => one.type === "webhook_card");
    expect(card).toMatchObject({ provider: "acme", event: "thing.happened" });

    expect(
      messages.body.messages
        .flatMap((one) => one.blocks)
        .filter((one) => one.type === "webhook_card"),
    ).toHaveLength(1);

    // Somebody else's signature is not this instance's.
    const forged = await fetch(`${base}/hooks/acme/${webhookId}`, {
      method: "POST",
      headers: new Headers({ ...Object.fromEntries(headers), "x-acme-signature": "sha256=beef" }),
      body,
    });
    expect(forged.status).toBe(403);
  }, 60_000);
});
