import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateSessionParams, Engine, EngineSession } from "@perch/engines";
import type { EngineEvent } from "@perch/events";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.15 (spec §3.4 brains, §3.6 lane A): a workspace's credentials and the models they reach.
 * The acceptance is that a key and an endpoint both run a session — here an OpenAI-shaped key and
 * an Ollama-shaped endpoint, both pointed at a stand-in provider — and the invariant is that the
 * secret reaches the engine's environment and nothing else: no listing, no error, no log line.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
let provider: ReturnType<typeof Bun.serve> | null = null;
let providerUrl = "";
const KEY = "sk-test-0000-secret-4f2a";

/** What the engine was handed when a session opened, so the test can look at its environment. */
const opened: CreateSessionParams[] = [];

const recorder: Engine = {
  id: "recorder",
  capabilities: { code: true, tools: false, subagents: false, streaming: true },
  async createSession(params: CreateSessionParams): Promise<EngineSession> {
    opened.push(params);
    return { id: params.sessionId };
  },
  async *send(): AsyncIterable<EngineEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  },
  async respondPermission() {},
  async cancel() {},
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
  return { cookie: cookiesFrom(res) };
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: (text ? JSON.parse(text) : null) as unknown,
  };
}

async function readyProject(cookie: string, ws: string, name: string): Promise<string> {
  const created = (await call(`/api/workspaces/${ws}/projects`, cookie, {
    method: "POST",
    json: { name },
  })) as { body: { id: string } };
  const id = created.body.id;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`, cookie)) as {
      body: { status: string; status_message: string | null };
    };
    if (res.body.status === "ready") return id;
    if (res.body.status === "error" || Date.now() > deadline) {
      throw new Error(`project ${res.body.status}: ${res.body.status_message}`);
    }
    await Bun.sleep(50);
  }
}

type Credential = { id: string; hint: string | null; status: string; provider: string };
type Profile = { id: string; name: string; default_for: string | null };

beforeAll(async () => {
  // A stand-in provider that answers the OpenAI-compatible model list, with or without a key.
  provider = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/models")) return new Response("no", { status: 404 });
      const auth = request.headers.get("authorization");
      if (url.pathname.startsWith("/key/")) {
        if (auth !== `Bearer ${KEY}`) return new Response("nope", { status: 401 });
        return Response.json({ data: [{ id: "gpt-test", owned_by: "stand-in" }] });
      }
      return Response.json({ data: [{ id: "llama-test" }] });
    },
  });
  providerUrl = `http://127.0.0.1:${provider.port}`;

  booted = await bootTestApp({}, { engines: [recorder], sessions: { silenceMs: 60_000 } });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-brains-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  provider?.stop(true);
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("brains (task 1.15)", () => {
  test("a key and an endpoint: listed, tested, profiled, and handed to an engine", async () => {
    const owner = await signUp("Bea", "bea-brains@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Brains Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;

    // The provider catalog is there before any credential is.
    const providers = (await call(`/api/workspaces/${ws}/providers`, owner.cookie)) as {
      status: number;
      body: { providers: { id: string; lists: boolean }[]; ollama: unknown };
    };
    expect(providers.status).toBe(200);
    expect(providers.body.providers.map((p) => p.id)).toContain("ollama");
    expect(providers.body.providers.find((p) => p.id === "anthropic")?.lists).toBe(false);

    // A key. The reply carries a hint, never the key, and neither does the list.
    const key = (await call(`/api/workspaces/${ws}/credentials`, owner.cookie, {
      method: "POST",
      json: {
        provider: "openai",
        kind: "api_key",
        scope: "workspace",
        label: "Test key",
        secret: KEY,
        base_url: `${providerUrl}/key/v1`,
      },
    })) as { status: number; text: string; body: Credential };
    expect(key.status).toBe(201);
    expect(key.body.hint).toBe("sk…4f2a");
    expect(key.text).not.toContain(KEY);

    // An endpoint with no secret at all, the way a laptop's Ollama arrives.
    const endpoint = (await call(`/api/workspaces/${ws}/credentials`, owner.cookie, {
      method: "POST",
      json: {
        provider: "ollama",
        kind: "endpoint",
        scope: "workspace",
        label: "Nest Ollama",
        base_url: `${providerUrl}/v1`,
      },
    })) as { status: number; body: Credential };
    expect(endpoint.status).toBe(201);
    expect(endpoint.body.hint).toBeNull();

    const listed = (await call(`/api/workspaces/${ws}/credentials`, owner.cookie)) as {
      text: string;
      body: { credentials: Credential[] };
    };
    expect(listed.body.credentials).toHaveLength(2);
    expect(listed.text).not.toContain(KEY);
    // The hint outlives the request that set the key: two keys stay tellable apart.
    expect(listed.body.credentials.find((c) => c.id === key.body.id)?.hint).toBe("sk…4f2a");
    expect(listed.body.credentials.find((c) => c.id === endpoint.body.id)?.hint).toBeNull();

    // Each one lists what it can reach, which is also the test button.
    const keyModels = (await call(
      `/api/workspaces/${ws}/models?credential=${key.body.id}`,
      owner.cookie,
    )) as { status: number; body: { models: { id: string }[] } };
    expect(keyModels.status).toBe(200);
    expect(keyModels.body.models.map((m) => m.id)).toEqual(["gpt-test"]);
    const endpointModels = (await call(
      `/api/workspaces/${ws}/models?credential=${endpoint.body.id}`,
      owner.cookie,
    )) as { body: { models: { id: string }[] } };
    expect(endpointModels.body.models.map((m) => m.id)).toEqual(["llama-test"]);

    // Two brains, one of them the workspace's default for code.
    const keyProfile = (await call(`/api/workspaces/${ws}/model-profiles`, owner.cookie, {
      method: "POST",
      json: {
        name: "Test GPT",
        provider: "openai",
        model_id: "gpt-test",
        credential_id: key.body.id,
        default_for: "code",
      },
    })) as { status: number; body: Profile };
    expect(keyProfile.status).toBe(201);
    expect(keyProfile.body.default_for).toBe("code");
    const localProfile = (await call(`/api/workspaces/${ws}/model-profiles`, owner.cookie, {
      method: "POST",
      json: {
        name: "Nest Llama",
        provider: "ollama",
        model_id: "llama-test",
        credential_id: endpoint.body.id,
      },
    })) as { body: Profile };

    // A session with no brain named takes the workspace's default for code…
    const project = await readyProject(owner.cookie, ws, "Brainy");
    opened.length = 0;
    const onDefault = (await call(
      `/api/workspaces/${ws}/projects/${project}/sessions`,
      owner.cookie,
      { method: "POST", json: { engine: "recorder", prompt: "hello" } },
    )) as { status: number; body: { id: string; model: { provider: string; model_id: string } } };
    expect(onDefault.status).toBe(201);
    expect(onDefault.body.model).toMatchObject({ provider: "openai", model_id: "gpt-test" });

    // …and the key reaches the engine's environment, which is the only place it may go.
    const deadline = Date.now() + 10_000;
    while (opened.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(opened[0]?.env).toMatchObject({ OPENAI_API_KEY: KEY });

    // The endpoint brain hands over its base URL instead, and no key.
    opened.length = 0;
    const onLocal = (await call(
      `/api/workspaces/${ws}/projects/${project}/sessions`,
      owner.cookie,
      {
        method: "POST",
        json: { engine: "recorder", model_profile_id: localProfile.body.id, prompt: "hello" },
      },
    )) as { status: number; body: { model: { provider: string; model_id: string } } };
    expect(onLocal.status).toBe(201);
    expect(onLocal.body.model).toMatchObject({ provider: "ollama", model_id: "llama-test" });
    while (opened.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(opened[0]?.env).toEqual({ OLLAMA_HOST: providerUrl });
    expect(JSON.stringify(opened[0]?.env)).not.toContain(KEY);
  }, 60_000);

  test("a wrong key is marked invalid; a stranger sees nothing; a member cannot share one", async () => {
    const owner = await signUp("Cal", "cal-brains@perch.test");
    const member = await signUp("Mo", "mo-brains@perch.test");
    const stranger = await signUp("Sid", "sid-brains@perch.test");
    const created = (await call("/api/workspaces", owner.cookie, {
      method: "POST",
      json: { name: "Keys Nest" },
    })) as { body: { id: string } };
    const ws = created.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, owner.cookie, {
      method: "POST",
      json: { email: "mo-brains@perch.test", role: "member" },
    })) as { status: number; body: { accept_url: string } };
    expect(invite.status).toBe(201);
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, member.cookie, { method: "POST" })).status,
    ).toBe(200);

    // A key the provider refuses: the row says invalid, and the message does not repeat the key.
    const bad = (await call(`/api/workspaces/${ws}/credentials`, owner.cookie, {
      method: "POST",
      json: {
        provider: "openai",
        kind: "api_key",
        scope: "workspace",
        label: "Wrong key",
        secret: "sk-wrong-key-value",
        base_url: `${providerUrl}/key/v1`,
      },
    })) as { body: Credential };
    const refused = await call(
      `/api/workspaces/${ws}/models?credential=${bad.body.id}`,
      owner.cookie,
    );
    expect(refused.status).toBe(502);
    expect(refused.text).not.toContain("sk-wrong-key-value");
    const after = (await call(`/api/workspaces/${ws}/credentials`, owner.cookie)) as {
      body: { credentials: Credential[] };
    };
    expect(after.body.credentials.find((c) => c.id === bad.body.id)?.status).toBe("invalid");

    // A member may add their own key, but not one the whole workspace runs on, and no profiles.
    const mine = await call(`/api/workspaces/${ws}/credentials`, member.cookie, {
      method: "POST",
      json: { provider: "openai", kind: "api_key", scope: "user", label: "Mine", secret: KEY },
    });
    expect(mine.status).toBe(201);
    expect(
      (
        await call(`/api/workspaces/${ws}/credentials`, member.cookie, {
          method: "POST",
          json: {
            provider: "openai",
            kind: "api_key",
            scope: "workspace",
            label: "Ours",
            secret: KEY,
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/api/workspaces/${ws}/model-profiles`, member.cookie, {
          method: "POST",
          json: { name: "Member brain", provider: "openai", model_id: "gpt-test" },
        })
      ).status,
    ).toBe(403);

    // Nor can anyone else build a brain on the member's own key: it is not theirs to use.
    expect(
      (
        await call(`/api/workspaces/${ws}/model-profiles`, owner.cookie, {
          method: "POST",
          json: {
            name: "Borrowed",
            provider: "openai",
            model_id: "gpt-test",
            credential_id: (mine.body as Credential).id,
          },
        })
      ).status,
    ).toBe(404);

    // The owner does not see the member's own key, and a stranger sees nothing at all.
    const ownerSees = (await call(`/api/workspaces/${ws}/credentials`, owner.cookie)) as {
      body: { credentials: Credential[] };
    };
    expect(ownerSees.body.credentials.map((c) => c.id)).not.toContain((mine.body as Credential).id);
    expect((await call(`/api/workspaces/${ws}/credentials`, stranger.cookie)).status).toBe(404);
    expect(
      (await call(`/api/workspaces/${ws}/models?credential=${bad.body.id}`, stranger.cookie))
        .status,
    ).toBe(404);
  }, 60_000);
});
