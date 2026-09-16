import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Manifest, parseManifest, tokenHeaders } from "@perch/connect";
import { MANIFESTS } from "@perch/connectors";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.25 (spec §5.5 seed list): every connector this build ships, put through the call that
 * proves a token works — with the wrong token first.
 *
 * A manifest can say anything. What this checks is the part that is easy to get wrong and silent
 * when it is: that `test_path` is an endpoint that needs the token, that the token goes out in the
 * header the manifest names and nowhere else, and that a provider answering `401` is a connection
 * Perch refuses rather than stores. The provider is a stand-in on this machine, because the point
 * is what Perch sends and what it does with the answer, not whether X is up.
 */

/**
 * The two tokens, behind whatever prefix this provider's manifest says a real one starts with —
 * a token of the wrong shape never reaches the provider at all, and the point here is the call.
 */
function tokensFor(manifest: Manifest): { right: string; wrong: string } {
  const prefix = manifest.token_prefix[0] ?? "";
  return { right: `${prefix}a-token-this-provider-issued`, wrong: `${prefix}a-token-it-did-not` };
}

type Seed = { id: string; manifest: Manifest };

const seeds: Seed[] = Object.entries(MANIFESTS)
  .map(([id, source]) => ({ id, manifest: parseManifest(source) }))
  // Linear and Railway are GraphQL over POST: there is no GET that proves a token, and their
  // manifests say so by having no `test_path` at all (the harness warns about it out loud).
  .filter((seed) => seed.manifest.test_path !== "/");

/** An answer shaped the way this manifest says to read it: `result.id` needs a `result`. */
function accountBody(manifest: Manifest, account: string): Record<string, unknown> {
  const path = manifest.account_field;
  if (!path) return { ok: true };
  const steps = path.split(".");
  let body: Record<string, unknown> = {};
  const top = body;
  for (const [at, step] of steps.entries()) {
    if (at === steps.length - 1) body[step] = account;
    else {
      const next: Record<string, unknown> = {};
      body[step] = next;
      body = next;
    }
  }
  return top;
}

let booted: Booted;
let running: RunningServer;
let base = "";
let cookie = "";
let ws = "";

/** The provider being stood in for right now, and what it saw. */
let current: Seed | null = null;
let sawHeaders: Headers | null = null;
let provider: ReturnType<typeof Bun.serve> | null = null;
let providerUrl = "";

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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as unknown };
}

beforeAll(async () => {
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const seed = current;
      if (!seed) return new Response("no provider", { status: 500 });
      sawHeaders = request.headers;
      const url = new URL(request.url);
      // A `test_path` may carry a query string of its own — Clerk's asks for one user.
      if (url.pathname !== seed.manifest.test_path.split("?")[0]) {
        return new Response(JSON.stringify({ error: "no such endpoint" }), { status: 404 });
      }
      // What this provider would accept, worked out from its own manifest.
      const wanted = tokenHeaders(seed.manifest, tokensFor(seed.manifest).right);
      for (const [name, value] of Object.entries(wanted)) {
        if (request.headers.get(name) !== value) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
      }
      return new Response(JSON.stringify(accountBody(seed.manifest, "somebody")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  providerUrl = `http://127.0.0.1:${provider.port}`;

  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      name: "Wren",
      email: "wren-seeds@perch.test",
      password: "correct horse battery staple",
    }),
  });
  expect(signUp.status).toBe(200);
  cookie = cookiesFrom(signUp);
  const made = (await call("/api/workspaces", { method: "POST", json: { name: "Seeds" } })) as {
    body: { id: string };
  };
  ws = made.body.id;
}, 60_000);

afterAll(async () => {
  await running?.stop();
  provider?.stop(true);
});

describe("the §5.5 seed connectors (task 3.25)", () => {
  test("all seventeen ship, the seven of task 3.25 among them", () => {
    for (const id of [
      "google-workspace",
      "jira",
      "cloudflare",
      "railway",
      "netlify",
      "heygen",
      "x",
    ]) {
      expect(Object.keys(MANIFESTS)).toContain(id);
    }
  });

  for (const seed of seeds) {
    test(`${seed.id}: a wrong token fails the test call, the right one passes`, async () => {
      current = seed;
      const { right, wrong } = tokensFor(seed.manifest);
      const connect = async (token: string) =>
        await call(`/api/workspaces/${ws}/connections`, {
          method: "POST",
          json: { kind: "token", provider: seed.id, token, api_base: providerUrl },
        });

      // A token this provider never issued: the test call answers 401 and nothing is stored.
      sawHeaders = null;
      const refused = await connect(wrong);
      expect(refused.status).toBe(502);
      expect(JSON.stringify(refused.body)).toContain("401");
      // Whatever went out, the token went out in the manifest's own header and nowhere else.
      const headers = sawHeaders as Headers | null;
      expect(headers).not.toBeNull();
      const carrying = [...(headers?.entries() ?? [])].filter(([, value]) => value.includes(wrong));
      expect(carrying.map(([name]) => name)).toEqual([seed.manifest.token_header.toLowerCase()]);

      // And the right one connects, reading the account out of wherever this provider puts it.
      const ok = await connect(right);
      expect(ok.status).toBe(201);
      const body = ok.body as { provider: string; account: string | null; hint: string | null };
      expect(body.provider).toBe(seed.id);
      expect(body.account).toBe(seed.manifest.account_field ? "somebody" : null);
      // The answer carries a hint, never the token.
      expect(JSON.stringify(body)).not.toContain(right);
    });
  }
});
