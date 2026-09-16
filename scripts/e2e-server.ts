#!/usr/bin/env bun
/**
 * Playwright's web server: builds apps/web (skip with E2E_SKIP_BUILD=1) and runs `perch dev` (laptop
 * mode: api, the built client, and the in-process runner on PGlite) on port 3999 with a throwaway
 * data dir, so specs exercise exactly what a laptop user runs.
 *
 * It also stands up a fake OpenAI-compatible provider on E2E_PROVIDER_PORT (3998) so the brains
 * spec (task 1.15) can add a key and an endpoint that really answer `GET /v1/models` without
 * reaching the internet; for task 2.6 a streaming `POST /v1/chat/completions` so a bot in a channel
 * really answers; and for task 2.17 a `POST /v1/embeddings` so a codebase index has vectors. A real
 * Vite dev server runs on E2E_VITE_PORT (3997) so the preview spec (task 1.18) proves HMR through
 * the proxy against the thing itself, not a stand-in.
 *
 * For the Phase 1 exit criterion (task 1.22) it also starts a stand-in GitHub — the repository the
 * loop clones, pushes to, and opens a pull request on — and a stand-in `opencode serve`, so the
 * spec can run through the OpenCode adapter on a machine with no key and no internet. For task 2.14
 * there is a stand-in MCP server with its own authorization server, so the connections spec can run
 * the discovery → registration → PKCE round-trip in a browser. Where each one is lands in
 * E2E_MANIFEST as JSON, because the specs are other processes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { startStandInGitHub } from "../apps/api/test/fixtures/github.ts";
import { startStandInMcp } from "../apps/api/test/fixtures/mcp-server.ts";
import { startStandInSupabase, startStandInVercel } from "../apps/api/test/fixtures/paas.ts";
import { startFakeOpenCode } from "../apps/runner/test/fixtures/opencode-server.ts";

const root = resolve(import.meta.dir, "..");
const port = process.env.E2E_PORT ?? "3999";

if (!process.env.E2E_SKIP_BUILD) {
  const build = Bun.spawnSync(["bun", "run", "--filter", "@perch/web", "build"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) process.exit(build.exitCode);
}

/**
 * A stand-in provider: it answers the OpenAI-compatible model list, and only with a key on the
 * paths that ask for one, so a spec can prove a credential was accepted or rejected.
 */
/**
 * What a bot says when it is named, by handle. Anything not here answers with what it was asked,
 * which is what most specs want; these are the ones whose words have to tag somebody.
 */
const SCRIPTED: Record<string, string> = {
  // Task 2.7: a lead tags one desk, and the thread's header counts two hops.
  lead: "<@gamma> what do you have?",
  // Task 2.21: three bots complete a fan-out — the desk tags two, and both answer.
  desk: "Asking the desk: <@crypto> <@gaming> what do you have?",
  crypto: "Crypto has the crypto piece.",
  gaming: "Gaming has the gaming piece.",
  // Task 2.21: a pair that will not stop, until the breaker stops them.
  ping: "<@pong> your turn",
  pong: "<@ping> no, yours",
};

/** One streamed answer in the OpenAI shape: text pieces, or a tool call, then a finish reason. */
function streamed(
  parts: { text?: string; delta?: Record<string, unknown>; finish: string }[],
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) =>
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
      const head = { id: "1", object: "chat.completion.chunk", created: 1, model: "gpt-test-mini" };
      for (const part of parts) {
        for (const piece of part.text?.match(/.{1,12}/g) ?? []) {
          send({
            ...head,
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          });
        }
        if (part.delta) {
          send({ ...head, choices: [{ index: 0, delta: part.delta, finish_reason: null }] });
        }
        send({
          ...head,
          choices: [{ index: 0, delta: {}, finish_reason: part.finish }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        });
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

const providerPort = Number(process.env.E2E_PROVIDER_PORT ?? "3998");
const provider = Bun.serve({
  port: providerPort,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    // A bot's brain (task 2.6): the OpenAI-compatible streaming shape, answering whoever asked.
    if (url.pathname.endsWith("/chat/completions")) {
      const body = (await request.json()) as {
        messages?: { role: string; content?: unknown }[];
        tools?: { function?: { name?: string } }[];
      };
      const last = [...(body.messages ?? [])].reverse().find((one) => one.role === "user");
      const asked = typeof last?.content === "string" ? last.content : "";
      const system = body.messages?.find((one) => one.role === "system");
      const handle = /writing @([a-z0-9_-]+)/.exec(String(system?.content ?? ""))?.[1] ?? "";
      // How much of the conversation it was shown, which is what proves a fresh chat (task 2.9).
      const turns = (body.messages ?? []).filter((one) => one.role !== "system").length;

      /**
       * A bot with an attached MCP server (task 3.6) is a bot that is offered tools, and a brain
       * that never calls one cannot prove the lane. So: asked about something an offered tool is
       * plainly for, it calls that tool; shown the answer, it says what the answer was. Which tool
       * is decided by the ask, not by this file knowing what Supabase is.
       */
      const offered = (body.tools ?? []).map((one) => one.function?.name ?? "").filter(Boolean);
      const wanted = offered.find((name) =>
        asked.toLowerCase().includes("table") ? name.endsWith("list_tables") : false,
      );
      const answered = (body.messages ?? []).find((one) => one.role === "tool");
      if (wanted && !answered) {
        return streamed([
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: wanted, arguments: "{}" },
                },
              ],
            },
            finish: "tool_calls",
          },
        ]);
      }
      if (answered) {
        const said =
          typeof answered.content === "string"
            ? answered.content
            : JSON.stringify(answered.content);
        return streamed([
          { text: `What the database says: ${said}`.slice(0, 900), finish: "stop" },
        ]);
      }

      // A lead tags the desk, which is what makes a chain in the browser (task 2.7); the desk,
      // the two specialists and the arguing pair are Phase 2's exit criterion (task 2.21).
      const reply =
        SCRIPTED[handle] ??
        `Reading you (${turns} shown). You said: ${asked.replace(/^[^:]*:\s*/, "")}`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
          for (const piece of reply.match(/.{1,12}/g) ?? []) {
            send({
              id: "1",
              object: "chat.completion.chunk",
              created: 1,
              model: "gpt-test-mini",
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            });
          }
          send({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-test-mini",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
          });
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    // The codebase index's brain (task 2.17): a bag of words over a fixed alphabet, which is near
    // for two texts that share words and needs no model to compute.
    if (url.pathname.endsWith("/embeddings")) {
      const body = (await request.json()) as { input?: string[]; dimensions?: number };
      const dimensions = body.dimensions ?? 1024;
      return Response.json({
        object: "list",
        data: (body.input ?? []).map((one, index) => {
          const vector = new Array<number>(dimensions).fill(0);
          for (const word of one.toLowerCase().match(/[a-z_]{2,}/g) ?? []) {
            let hash = 0;
            for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % dimensions;
            vector[hash] = (vector[hash] ?? 0) + 1;
          }
          return { object: "embedding", index, embedding: vector };
        }),
      });
    }
    if (!url.pathname.endsWith("/models")) return new Response("not found", { status: 404 });
    const needsKey = url.pathname.startsWith("/key/");
    if (needsKey && !request.headers.get("authorization")?.startsWith("Bearer ")) {
      return Response.json({ error: "no key" }, { status: 401 });
    }
    return Response.json({
      object: "list",
      data: [
        { id: "gpt-test-mini", object: "model", owned_by: "e2e" },
        { id: "llama-test", object: "model", owned_by: "e2e" },
        { id: "embed-test", object: "model", owned_by: "e2e" },
      ],
    });
  },
});

/**
 * A one-file Vite app for the preview spec (task 1.18): the page prints a message from a module it
 * accepts hot, so an edit that changes the text without a reload is HMR and nothing else.
 */
const vitePort = Number(process.env.E2E_VITE_PORT ?? "3997");
// A fixed path, because the spec (a separate process) edits a module in it to prove HMR.
const viteDir = process.env.E2E_VITE_DIR ?? join(tmpdir(), "perch-e2e-preview-app");
rmSync(viteDir, { recursive: true, force: true });
mkdirSync(join(viteDir, "src"), { recursive: true });
writeFileSync(
  join(viteDir, "index.html"),
  '<!doctype html><html lang="en"><head><title>Preview app</title></head><body>' +
    '<h1 id="app">booting</h1>' +
    // Tagged the way the @perch/inspector dev plugin tags JSX (task 2.16). The transform itself is
    // covered by packages/inspector's unit tests; what the browser spec needs is an element that
    // says where it came from, so the inspector's chip can name a file the agent then edits.
    '<button id="cta" data-perch-src="src/App.tsx:12:5">Subscribe</button>' +
    '<script type="module" src="/src/main.js"></script></body></html>\n',
);
writeFileSync(
  join(viteDir, "src", "main.js"),
  [
    'import { message } from "./message.js";',
    'const paint = (text) => { document.getElementById("app").textContent = text; };',
    "paint(message);",
    'if (import.meta.hot) import.meta.hot.accept("./message.js", (next) => paint(next.message));',
    "",
  ].join("\n"),
);
writeFileSync(join(viteDir, "src", "message.js"), 'export const message = "version one";\n');
writeFileSync(
  join(viteDir, "vite.config.mjs"),
  // allowedHosts: a preview hostname is not one Vite knows about, and it is right to ask.
  `export default { server: { host: "127.0.0.1", port: ${vitePort}, strictPort: true, allowedHosts: true } };\n`,
);
writeFileSync(join(viteDir, "package.json"), '{ "name": "perch-e2e-preview", "type": "module" }\n');
/**
 * And a page that throws on load, for preflight (task 3.21, 3.23): every unit test in the world
 * passes for this page, and one look at it in a browser does not. It is a second page rather than
 * a change to the first, because the preview spec is watching that one.
 */
writeFileSync(
  join(viteDir, "boom.html"),
  "<!doctype html><html><body><h1>shipping</h1><script>brokenOnLoad();</script></body></html>\n",
);
const viteBin = resolve(root, "apps/web/node_modules/.bin/vite");
const vite = Bun.spawn(["bun", viteBin], {
  cwd: viteDir,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
});

/**
 * A stand-in `opencode serve` (apps/runner/test/fixtures): the endpoints the adapter uses, with the
 * SSE stream its SDK reads. The real binary needs a provider key and the internet to answer a
 * prompt; the adapter, the SDK and every event shape between them are the same either way, and the
 * binary itself is spike 0.4.3's subject (ADR-0031).
 */
const opencode = startFakeOpenCode();

/**
 * The repository the exit-criterion spec clones through a GitHub connection, pushes a commit to,
 * and opens a pull request on — one per lane, so that four runs of the same loop cannot see each
 * other's work. Its .perch/project.json is the one a project ships with: the engine the lanes
 * without an engine picker run on, and the port a preview is served from (spec §5.1).
 */
const LANES = ["key", "ollama", "opencode", "acp"];
const origins = await Promise.all(
  LANES.map((lane) =>
    startStandInGitHub({
      files: {
        "README.md": `# Nest\n\nThe project the ${lane} loop runs on.\n`,
        "src/app.ts": "export const answer = 42;\n",
        ".perch/project.json": `${JSON.stringify(
          { engine: "acp", preview: { port: vitePort, path: "/" } },
          null,
          2,
        )}\n`,
      },
    }),
  ),
);
/**
 * And Phase 3's own origin (task 3.23): the repository three agents share. Its config is the one
 * that makes that possible — a check command for the merge queue, and the edits an agent may make
 * with nobody watching, which is the repository saying what it trusts (ADR-0111).
 */
const phase3 = await startStandInGitHub({
  files: {
    "README.md": "# Aviary\n\nThe repository the Phase 3 loop works on.\n",
    "notes.txt": "release notes\n",
    ".perch/project.json": `${JSON.stringify(
      {
        engine: "acp",
        run: { check: "true" },
        preview: { port: vitePort, path: "/" },
        background: { unattended: ["Edit *"], autoSettle: true },
      },
      null,
      2,
    )}\n`,
  },
});

const github = Object.fromEntries([
  ...LANES.map((lane, i) => {
    const origin = origins[i];
    if (!origin) throw new Error(`no stand-in for ${lane}`);
    return [
      lane,
      { url: origin.url, repoUrl: origin.repoUrl, token: origin.token, login: origin.login },
    ] as const;
  }),
  [
    "phase3",
    {
      url: phase3.url,
      repoUrl: phase3.repoUrl,
      token: phase3.token,
      login: phase3.login,
    },
  ] as const,
]);

/**
 * A stand-in MCP server with its own authorization server (task 2.14), so the connections spec can
 * run the whole discovery → registration → PKCE round-trip in a browser: RFC 9728 metadata, RFC
 * 8414 endpoints, RFC 7591 registration, and an authorize endpoint that redirects straight back.
 * Supabase's real one is the thing being stood in for; every byte of the protocol is the same.
 */
const mcp = startStandInMcp();

/**
 * The two platforms task 2.15 ships through: a Vercel whose deployments really move from building
 * to ready, and a Supabase whose MCP server really lists tables. Both are reached through the
 * connection's own `api_base` and `mcp_url`, the way a self-hosted one would be.
 */
const vercel = startStandInVercel({ readyAfterMs: 1_500 });
const supabase = startStandInSupabase();

/** Where the specs (other processes) read all of this from. */
const manifestPath = process.env.E2E_MANIFEST ?? join(tmpdir(), "perch-e2e-manifest.json");
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      github,
      opencode: { url: opencode.url },
      provider: { url: `http://127.0.0.1:${providerPort}` },
      mcp: { url: mcp.mcpUrl, issuer: mcp.issuer },
      vercel: { url: vercel.url, token: vercel.token },
      supabase: { url: supabase.url, mcpUrl: supabase.mcpUrl, token: supabase.token },
      vite: { port: vitePort, dir: viteDir },
    },
    null,
    2,
  )}\n`,
);

/**
 * The browser the runner takes screenshots with (task 2.16). Playwright already installed one for
 * these specs, so the runner is pointed at that one rather than needing a second install.
 */
function chromiumPath(): string | undefined {
  if (process.env.PERCH_CHROMIUM) return process.env.PERCH_CHROMIUM;
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "perch-e2e-"));
const api = Bun.spawn(
  [
    "bun",
    "apps/cli/src/index.ts",
    "dev",
    "--port",
    port,
    "--host",
    "127.0.0.1",
    "--public-url",
    process.env.E2E_BASE_URL ?? `http://perch.localhost:${port}`,
    "--data-dir",
    dataDir,
    "--log-level",
    process.env.PERCH_LOG_LEVEL ?? "warn",
    "--preview-domain",
    process.env.E2E_PREVIEW_DOMAIN ?? "perch.localhost",
  ],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // A brain's variables must come from the credential the spec added and nowhere else, so the
      // machine's own provider keys stay out of the session (task 1.15).
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GROQ_API_KEY: undefined,
      MISTRAL_API_KEY: undefined,
      XAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      OLLAMA_HOST: undefined,
      OPENAI_BASE_URL: undefined,
      // Sessions run on the fake ACP agent of the runner's tests (task 1.12's spec needs no key).
      PERCH_ACP_AGENTS: JSON.stringify({
        fake: {
          name: "Fake Agent",
          command: process.execPath,
          args: [resolve(root, "apps/runner/test/fixtures/acp-agent.ts")],
        },
      }),
      PERCH_ACP_AGENT: "fake",
      // The OpenCode lane runs on the stand-in server rather than a binary this machine may not
      // have (task 1.10's `baseUrl` seam, named by the environment).
      PERCH_OPENCODE_URL: opencode.url,
      // Where the runner finds a headless browser for `preview.screenshot` (task 2.16).
      PERCH_CHROMIUM: chromiumPath(),
    },
  },
);

const stop = () => {
  provider.stop(true);
  mcp.stop();
  vercel.stop();
  supabase.stop();
  vite.kill();
  opencode.close();
  for (const origin of origins) origin.stop();
  api.kill();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// The wizard is one-time per database: complete it here (as e2e/00-setup.e2e.ts would through the UI)
// unless E2E_SETUP=wizard leaves it to that spec, so every other spec starts from a set-up instance.
if (process.env.E2E_SETUP !== "wizard") {
  // Reached by address (this process has no resolver rules), but the wizard is told the public URL
  // the browser uses, which is what the instance is configured with.
  const base = `http://127.0.0.1:${port}`;
  const publicUrl = process.env.E2E_BASE_URL ?? `http://perch.localhost:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  const res = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicUrl },
    body: JSON.stringify({
      admin: {
        name: "E2E Admin",
        email: "admin@perch.test",
        password: "admin-passphrase-for-tests",
      },
      workspace: { name: "Admin" },
      public_url: publicUrl,
      telemetry: false,
    }),
  });
  if (res.status !== 201 && res.status !== 409) {
    console.error(`e2e setup failed: ${res.status} ${await res.text()}`);
    stop();
    process.exit(1);
  }
}

process.exit(await api.exited);
