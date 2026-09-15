import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * Laptop-mode parity (task 1.21): everything tasks 1.4 through 1.20 added, driven through a real
 * `perch dev` process on PGlite with the in-process runner — no Docker, no Postgres, no separate
 * api. If a feature works in team mode and not here, this is where it shows.
 *
 * One process, one workspace, one project, and then the whole of Phase 1 over HTTP: the file
 * system, git, a session with a permission and a diff, an inline edit, a preview, a brain, a
 * connection, the MCP gateway's door, and a terminal. CI runs it on Linux, macOS, and Windows.
 */

const cli = resolve(import.meta.dir, "..", "src", "index.ts");
const agent = resolve(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");

/**
 * The laptop this test simulates has one agent on it: the fake ACP one below. A runner reports the
 * engines whose programs it can find, and `opencode` on PATH would make it report OpenCode — which
 * a new project's default engine then picks for the lanes that have no engine picker (⌘K and the
 * commit message), sending the round off this machine. So the child is handed a PATH without it,
 * rather than a result that depends on what happens to be installed.
 */
function laptopPath(): string {
  const names = process.platform === "win32" ? ["opencode.exe", "opencode.cmd"] : ["opencode"];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !names.some((name) => existsSync(join(dir, name))))
    .join(delimiter);
}

let dataDir = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let url = "";
let cookie = "";
let ws = "";
let project = "";
/** A stand-in provider for the brains and connections lanes, and a dev server for the preview. */
let provider: ReturnType<typeof Bun.serve> | null = null;
let providerUrl = "";
let site: ReturnType<typeof Bun.serve> | null = null;
let sitePort = 0;

const ADMIN = { name: "Laptop Admin", email: "admin@perch.test", password: "a-long-passphrase" };
const TOKEN = "github_pat_11LAPTOP0000parity0000wxyz";

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpMatchArray> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
    ]);
    if (chunk === null || chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
    const match = output.match(pattern);
    if (match) {
      reader.releaseLock();
      return match;
    }
  }
  reader.releaseLock();
  throw new Error(`pattern ${pattern} not seen in:\n${output}`);
}

async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: url },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as unknown };
}

async function untilProject(status: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${project}`)) as {
      body: { status: string; status_message: string | null };
    };
    if (res.body.status === status) return;
    if (res.body.status === "error" || Date.now() > deadline) {
      throw new Error(`project ${res.body.status}: ${res.body.status_message}`);
    }
    await Bun.sleep(100);
  }
}

async function untilSession(id: string, status: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = (await call(`/api/sessions/${id}`)) as {
      body: { status: string; status_message: string | null; turns: number };
    };
    if (res.body.status === status) return res.body;
    if (Date.now() > deadline) {
      throw new Error(`session stayed ${res.body.status} (${res.body.status_message})`);
    }
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  // A provider that answers an OpenAI-style model list and a GitHub-style /user, so the brains and
  // connections lanes have something real to talk to without leaving the machine.
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "laptop-mini", object: "model" }] });
      }
      if (path === "/user") {
        if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        return Response.json({ login: "octocat" }, { headers: { "x-oauth-scopes": "repo" } });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  providerUrl = `http://127.0.0.1:${provider.port}`;

  // A dev server on a port, for the preview.
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response("<h1 id=app>a laptop preview</h1>", {
        headers: { "content-type": "text/html" },
      }),
  });
  sitePort = site.port as number;

  // A real port rather than 0: laptop mode derives PERCH_PUBLIC_URL from it, and the wizard checks
  // the public URL it is given against that.
  const reserved = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = String(reserved.port);
  reserved.stop(true);

  dataDir = mkdtempSync(join(tmpdir(), "perch-parity-"));
  proc = Bun.spawn(
    ["bun", cli, "dev", "--port", port, "--data-dir", dataDir, "--log-level", "warn"],
    {
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...process.env,
        PATH: laptopPath(),
        PERCH_PUBLIC_URL: "",
        PORT: "",
        // Sessions run on the runner tests' fake ACP agent: no key, no network.
        PERCH_ACP_AGENTS: JSON.stringify({
          fake: { name: "Fake Agent", command: process.execPath, args: [agent] },
        }),
        PERCH_ACP_AGENT: "fake",
      },
    },
  );
  const match = await readUntil(
    proc.stdout as ReadableStream<Uint8Array>,
    /perch dev: (http:\/\/[^\s]+)/,
    90_000,
  );
  url = match[1] ?? "";

  // The wizard, once, exactly as the browser would do it.
  const setup = await fetch(`${url}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({
      admin: ADMIN,
      workspace: { name: "Laptop" },
      public_url: url,
      telemetry: false,
    }),
  });
  expect([201, 409]).toContain(setup.status);
  const signIn = await fetch(`${url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  expect(signIn.status).toBe(200);
  cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
  const workspaces = (await call("/api/workspaces")) as { body: { workspaces: { id: string }[] } };
  ws = workspaces.body.workspaces[0]?.id ?? "";
  expect(ws).not.toBe("");
}, 180_000);

afterAll(async () => {
  proc?.kill("SIGTERM");
  await proc?.exited;
  provider?.stop(true);
  site?.stop(true);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("laptop mode runs all of Phase 1 (task 1.21)", () => {
  test("a project, its files, and its git (tasks 1.4, 1.5, 1.6, 1.20)", async () => {
    const created = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "Parity" },
    })) as { status: number; body: { id: string } };
    expect(created.status).toBe(201);
    project = created.body.id;
    await untilProject("ready");

    const wrote = await call(`/api/workspaces/${ws}/projects/${project}/fs/write`, {
      method: "PUT",
      json: { path: "src/app.ts", content: "export const answer = 42;\n" },
    });
    expect(wrote.status).toBe(200);

    const read = (await call(
      `/api/workspaces/${ws}/projects/${project}/fs/read?path=src%2Fapp.ts`,
    )) as { body: { content: string } };
    expect(read.body.content).toContain("answer = 42");

    const searched = (await call(
      `/api/workspaces/${ws}/projects/${project}/fs/search?q=answer`,
    )) as { body: { matches: { path: string }[] } };
    expect(searched.body.matches.map((m) => m.path)).toContain("src/app.ts");

    // Git: the change is seen, the agent names it, and it commits.
    const status = (await call(`/api/workspaces/${ws}/projects/${project}/git/status`)) as {
      body: { clean: boolean; files: { path: string }[] };
    };
    expect(status.body.clean).toBe(false);
    const drafted = (await call(`/api/workspaces/${ws}/projects/${project}/git/message`, {
      method: "POST",
      json: {},
    })) as { status: number; body: { message: string; session_id: string } };
    expect(drafted.status).toBe(200);
    expect(drafted.body.message.length).toBeGreaterThan(0);
    // The lane with no engine picker opened on the one agent this laptop has.
    const inlineSession = (await call(`/api/sessions/${drafted.body.session_id}`)) as {
      body: { engine: string };
    };
    expect(inlineSession.body.engine).toBe("acp");
    const committed = (await call(`/api/workspaces/${ws}/projects/${project}/git/commit`, {
      method: "POST",
      json: { message: drafted.body.message },
    })) as { status: number; body: { commit: string } };
    expect(committed.status).toBe(201);
    const after = (await call(`/api/workspaces/${ws}/projects/${project}/git/status`)) as {
      body: { clean: boolean };
    };
    expect(after.body.clean).toBe(true);
  }, 180_000);

  test("a session with a permission, its diff, and an inline edit (tasks 1.8–1.14)", async () => {
    const opened = (await call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      json: {
        engine: "acp",
        model: { provider: "fake", model_id: "default" },
        prompt: "edit the notes",
      },
    })) as { status: number; body: { id: string } };
    expect(opened.status).toBe(201);
    const session = opened.body.id;

    // The agent asks before it writes; laptop mode answers the same way team mode does.
    await untilSession(session, "needs_you");
    const answered = await call(`/api/sessions/${session}/permissions/p1`, {
      method: "POST",
      json: { answer: "allow" },
    });
    expect(answered.status).toBe(200);
    await untilSession(session, "idle");

    const events = (await call(`/api/sessions/${session}/events`)) as {
      body: { events: { event: { type: string } }[] };
    };
    expect(events.body.events.map((e) => e.event.type)).toContain("tool_result");

    // The turn's diff, from the checkpoint the runner took.
    const diff = (await call(`/api/sessions/${session}/diff`)) as {
      body: { files: { path: string }[] };
    };
    expect(diff.body.files.map((f) => f.path)).toContain("notes.txt");

    // ⌘K: a selection rewritten in place, on the project's inline lane.
    const inline = (await call(`/api/workspaces/${ws}/projects/${project}/inline-edit`, {
      method: "POST",
      json: {
        path: "src/app.ts",
        selection: "export const answer = 42;",
        instruction: "make it uppercase",
        language: "ts",
      },
    })) as { status: number; body: { replacement: string } };
    expect(inline.status).toBe(200);
    expect(inline.body.replacement).toContain("EXPORT CONST ANSWER");
  }, 180_000);

  test("a brain, a connection, and the gateway's door (tasks 1.15, 1.16, 1.17)", async () => {
    // A key that a provider really answers for, and a profile that names a model from its catalog.
    const credential = (await call(`/api/workspaces/${ws}/credentials`, {
      method: "POST",
      json: {
        provider: "openai",
        kind: "api_key",
        label: "Laptop key",
        secret: "sk-laptop-parity",
        base_url: `${providerUrl}/v1`,
        scope: "user",
      },
    })) as { status: number; body: { id: string; hint: string | null } };
    expect(credential.status).toBe(201);
    // The key went in and does not come back out (AGENTS.md §1.6).
    expect(JSON.stringify(credential.body)).not.toContain("sk-laptop-parity");

    const models = (await call(
      `/api/workspaces/${ws}/models?credential=${credential.body.id}`,
    )) as { status: number; body: { models: { id: string }[] } };
    expect(models.status).toBe(200);
    expect(models.body.models.map((m) => m.id)).toContain("laptop-mini");

    const profile = (await call(`/api/workspaces/${ws}/model-profiles`, {
      method: "POST",
      json: {
        name: "Laptop brain",
        provider: "openai",
        model_id: "laptop-mini",
        credential_id: credential.body.id,
      },
    })) as { status: number };
    expect(profile.status).toBe(201);

    // A pasted token, checked against the provider before it is kept.
    const connection = (await call(`/api/workspaces/${ws}/connections`, {
      method: "POST",
      json: { kind: "token", provider: "github", token: TOKEN, api_base: providerUrl },
    })) as { status: number; body: { id: string; account: string | null } };
    expect(connection.status).toBe(201);
    expect(connection.body.account).toBe("octocat");

    // The MCP gateway is mounted and asks for a token rather than letting anyone in.
    const gateway = await fetch(`${url}/mcp/${connection.body.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(gateway.status).toBe(401);
    expect(gateway.headers.get("www-authenticate")).toBe('Bearer realm="perch"');
  }, 180_000);

  test("a preview, proxied to a port on this machine (tasks 1.18, 1.19)", async () => {
    // The in-process runner's poller has to have noticed the port.
    const deadline = Date.now() + 20_000;
    let seen = false;
    while (Date.now() < deadline && !seen) {
      const res = (await call(`/api/workspaces/${ws}/projects/${project}/previews`)) as {
        body: { ports: { port: number }[] };
      };
      seen = res.body.ports.some((p) => p.port === sitePort);
      if (!seen) await Bun.sleep(250);
    }
    expect(seen).toBe(true);

    const page = await fetch(`${url}/p/${ws}/${sitePort}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("a laptop preview");

    // A share link opens it without a session at all.
    const share = (await call(
      `/api/workspaces/${ws}/projects/${project}/previews/${sitePort}/share`,
      { method: "POST", json: { public: true, expires_in_hours: 1 } },
    )) as { status: number; body: { url: string } };
    expect(share.status).toBe(201);
    const shared = await fetch(share.body.url);
    expect(shared.status).toBe(200);
    expect(await shared.text()).toContain("a laptop preview");
  }, 120_000);

  test("a terminal, over the same port (task 1.7)", async () => {
    const socket = new WebSocket(
      `${url.replace("http", "ws")}/api/workspaces/${ws}/projects/${project}/terminal`,
      { headers: { cookie } } as unknown as string[],
    );
    const output: string[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the shell never spoke")), 30_000);
      socket.addEventListener("message", (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data)) as { t: string; d?: string };
        if (frame.t === "open") socket.send(JSON.stringify({ t: "i", d: "echo parity-ok\r" }));
        if (frame.t === "o" && frame.d) {
          output.push(frame.d);
          if (output.join("").includes("parity-ok")) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the terminal socket failed"));
      });
    });
    try {
      await ready;
      expect(output.join("")).toContain("parity-ok");
    } finally {
      socket.close();
    }
  }, 120_000);
});
