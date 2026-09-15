#!/usr/bin/env bun
/**
 * Playwright's web server: builds apps/web (skip with E2E_SKIP_BUILD=1) and runs `perch dev` (laptop
 * mode: api, the built client, and the in-process runner on PGlite) on port 3999 with a throwaway
 * data dir, so specs exercise exactly what a laptop user runs.
 *
 * It also stands up a fake OpenAI-compatible provider on E2E_PROVIDER_PORT (3998) so the brains
 * spec (task 1.15) can add a key and an endpoint that really answer `GET /v1/models` without
 * reaching the internet.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const providerPort = Number(process.env.E2E_PROVIDER_PORT ?? "3998");
const provider = Bun.serve({
  port: providerPort,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
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
      ],
    });
  },
});

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
    `http://localhost:${port}`,
    "--data-dir",
    dataDir,
    "--log-level",
    process.env.PERCH_LOG_LEVEL ?? "warn",
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
    },
  },
);

const stop = () => {
  provider.stop(true);
  api.kill();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// The wizard is one-time per database: complete it here (as e2e/00-setup.e2e.ts would through the UI)
// unless E2E_SETUP=wizard leaves it to that spec, so every other spec starts from a set-up instance.
if (process.env.E2E_SETUP !== "wizard") {
  const base = `http://localhost:${port}`;
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
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      admin: {
        name: "E2E Admin",
        email: "admin@perch.test",
        password: "admin-passphrase-for-tests",
      },
      workspace: { name: "Admin" },
      public_url: base,
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
