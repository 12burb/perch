import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusEvent, RunnerLink } from "@perch/events";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { projectDeps } from "../src/routes/projects.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { decryptDeployKey } from "../src/services/deploy-keys.ts";
import { createProject } from "../src/services/projects.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.4 (spec §5.1): projects are created empty, for uploads, or by cloning over HTTPS with a
 * token (through git's credential helper, the token never stored) or SSH with the workspace deploy
 * key; the directory is set up on a runner (the in-process one here) and the row follows with
 * status, head, the validated .perch/project.json (defaults applied) and the parsed devcontainer.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let projectsDir = "";
const events: BusEvent[] = [];
const tmpDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

const TOKEN = "ghp_SecretToken_1234567890";

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

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

async function call(
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown; form?: FormData } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { cookie, origin: base };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

type ProjectRow = {
  id: string;
  key: string;
  name: string;
  source: string;
  status: string;
  status_message: string | null;
  repo_url: string | null;
  default_branch: string;
  default_engine: string;
  runner_id: string | null;
  head: string | null;
  config: Record<string, unknown>;
  config_error: string | null;
  devcontainer: Record<string, unknown> | null;
};

async function waitForStatus(
  ws: string,
  id: string,
  cookie: string,
  statuses: string[],
  ms = 30_000,
): Promise<ProjectRow> {
  const deadline = Date.now() + ms;
  for (;;) {
    const res = (await call(`/api/workspaces/${ws}/projects/${id}`, cookie)) as {
      status: number;
      body: ProjectRow;
    };
    expect(res.status).toBe(200);
    if (statuses.includes(res.body.status)) return res.body;
    if (Date.now() > deadline)
      throw new Error(`still ${res.body.status}: ${res.body.status_message}`);
    await Bun.sleep(50);
  }
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
}

/** A repository to clone: config, a JSONC devcontainer with a postCreateCommand, one commit. */
async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const work = tmp("perch-fixture-");
  git(work, "init", "--initial-branch", "trunk");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, "add", ".");
  git(work, "commit", "-m", "initial");
  const bare = join(tmp("perch-bare-"), "repo.git");
  git(work, "clone", "--bare", work, bare);
  git(bare, "update-server-info");
  return bare;
}

/**
 * git's dumb HTTP protocol over a bare repository (info/refs and objects as static files), with an
 * optional Basic-auth gate: enough to prove the token reaches git through the credential helper.
 */
function serveRepo(bare: string, auth?: { username: string; password: string }): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (auth) {
        const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
        if (req.headers.get("authorization") !== expected) {
          return new Response("auth required", {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="perch tests"' },
          });
        }
      }
      const pathname = new URL(req.url).pathname.replace(/^\/repo\.git\/?/, "");
      const file = join(bare, pathname);
      if (
        !pathname ||
        !existsSync(file) ||
        (Bun.file(file).size === 0 && !pathname.endsWith("HEAD"))
      ) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(file), { headers: { "content-type": "text/plain" } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/repo.git`;
}

const GOOD_FILES = {
  "README.md": "# hello\n",
  ".perch/project.json": JSON.stringify({ engine: "hermes", run: { test: "bun test" } }),
  ".devcontainer/devcontainer.json": `{
  // comments are fine in devcontainer.json
  "name": "hello",
  "postCreateCommand": "echo created > created.txt",
}
`,
};

beforeAll(async () => {
  booted = await bootTestApp({});
  projectsDir = tmp("perch-projects-");
  booted.runners.attach(createInProcessRunner({ projectsDir }));
  booted.bus.subscribe("*", (event) => {
    if (event.type.startsWith("project.") || event.type === "workspace.updated") events.push(event);
  });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
});

afterAll(async () => {
  await running.stop();
  for (const server of servers) server.stop(true);
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function workspaceFor(cookie: string): Promise<string> {
  const created = (await call("/api/workspaces", cookie, {
    method: "POST",
    json: { name: `Nest ${Math.random().toString(36).slice(2, 8)}` },
  })) as { status: number; body: { id: string } };
  expect(created.status).toBe(201);
  return created.body.id;
}

describe("projects api (task 1.4)", () => {
  test("an empty project: a fresh repository on the requested branch, events, and the key from the name", async () => {
    const owner = await signUp("Olive", "olive-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    const created = (await call(`/api/workspaces/${ws}/projects`, owner.cookie, {
      method: "POST",
      json: { name: "Nest App", default_branch: "develop" },
    })) as { status: number; body: ProjectRow };
    expect(created.status).toBe(201);
    expect(created.body.key).toBe("nest-app");
    expect(created.body.source).toBe("empty");
    expect(["pending", "setting_up", "ready"]).toContain(created.body.status);

    const ready = await waitForStatus(ws, created.body.id, owner.cookie, ["ready", "error"]);
    expect(ready.status).toBe("ready");
    expect(ready.default_branch).toBe("develop");
    expect(ready.head).toBeNull();
    expect(ready.status_message).toBeNull();
    expect(existsSync(join(projectsDir, ws, ready.id, ".git"))).toBe(true);

    const list = (await call(`/api/workspaces/${ws}/projects`, owner.cookie)) as {
      body: { projects: ProjectRow[] };
    };
    expect(list.body.projects.map((p) => p.id)).toEqual([ready.id]);
    const mine = events.filter((e) => (e.payload as { projectId?: string }).projectId === ready.id);
    expect(mine.map((e) => e.type)).toEqual([
      "project.created",
      "project.updated",
      "project.updated",
    ]);

    // The same key again conflicts; a bad key is rejected.
    const dup = await call(`/api/workspaces/${ws}/projects`, owner.cookie, {
      method: "POST",
      json: { name: "Other", key: "nest-app" },
    });
    expect(dup.status).toBe(409);
    const bad = await call(`/api/workspaces/${ws}/projects`, owner.cookie, {
      method: "POST",
      json: { name: "Other", key: "-nope" },
    });
    expect(bad.status).toBe(422);
  }, 60_000);

  test("a clone with a token: files, validated config with defaults applied, devcontainer honored", async () => {
    const owner = await signUp("Clara", "clara-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    const bare = await fixtureRepo(GOOD_FILES);
    const url = serveRepo(bare, { username: "x-access-token", password: TOKEN });

    const created = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
      method: "POST",
      json: { name: "Hello", repo_url: url, auth: { kind: "token", token: TOKEN } },
    })) as { status: number; body: ProjectRow };
    expect(created.status).toBe(201);
    expect(created.body.source).toBe("clone");
    expect(created.body.repo_url).toBe(url);

    const ready = await waitForStatus(ws, created.body.id, owner.cookie, ["ready", "error"]);
    expect(ready.status_message).toBeNull();
    expect(ready.status).toBe("ready");
    expect(ready.head).toMatch(/^[0-9a-f]{40}$/);
    expect(ready.default_branch).toBe("trunk");
    expect(ready.config).toEqual({ engine: "hermes", run: { test: "bun test" } });
    expect(ready.default_engine).toBe("hermes");
    expect(ready.config_error).toBeNull();
    expect(ready.devcontainer).toMatchObject({ name: "hello" });
    const dir = join(projectsDir, ws, ready.id);
    expect(readFileSync(join(dir, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe("# hello\n");
    expect(readFileSync(join(dir, "created.txt"), "utf8").trim()).toBe("created");

    // The token is nowhere: not in the row, not in any event, not in the clone's remote URL.
    expect(JSON.stringify(ready)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain(TOKEN);
  }, 60_000);

  test("a clone that git refuses ends in error with a scrubbed message; a bad config is reported", async () => {
    const owner = await signUp("Dana", "dana-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    const bare = await fixtureRepo(GOOD_FILES);
    const url = serveRepo(bare, { username: "x-access-token", password: TOKEN });

    const denied = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
      method: "POST",
      json: { name: "Denied", repo_url: url },
    })) as { body: ProjectRow };
    const failed = await waitForStatus(ws, denied.body.id, owner.cookie, ["ready", "error"]);
    expect(failed.status).toBe("error");
    expect(failed.status_message).toMatch(/git clone failed/);
    expect(existsSync(join(projectsDir, ws, failed.id))).toBe(false);

    const badConfig = await fixtureRepo({
      "README.md": "x",
      ".perch/project.json": JSON.stringify({ engine: "nope" }),
    });
    const created = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
      method: "POST",
      json: { name: "Bad config", repo_url: serveRepo(badConfig) },
    })) as { body: ProjectRow };
    const ready = await waitForStatus(ws, created.body.id, owner.cookie, ["ready", "error"]);
    expect(ready.status).toBe("ready");
    expect(ready.config).toEqual({});
    expect(ready.config_error).toMatch(/project\.json: engine/);
    expect(ready.default_engine).toBe("opencode");
  }, 60_000);

  test("repo_url validation: embedded credentials, local paths, and file URLs are refused", async () => {
    const owner = await signUp("Eve", "eve-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    for (const repo_url of [
      "https://user:tok@github.com/o/r.git",
      "file:///etc",
      "/srv/repo",
      "ftp://x/y",
      "not a url",
    ]) {
      const res = await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
        method: "POST",
        json: { name: "X", repo_url },
      });
      expect(res.status, repo_url).toBe(422);
    }
    for (const repo_url of ["git@github.com:o/r.git", "ssh://git@github.com/o/r.git"]) {
      const res = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
        method: "POST",
        json: { name: `ok ${repo_url.length}`, repo_url, auth: { kind: "deploy_key" } },
      })) as { status: number; body: ProjectRow };
      expect(res.status, repo_url).toBe(201);
    }
  }, 60_000);

  test("uploads: files land in the project directory, paths cannot escape, not before ready", async () => {
    const owner = await signUp("Finn", "finn-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    const created = (await call(`/api/workspaces/${ws}/projects`, owner.cookie, {
      method: "POST",
      json: { name: "Uploaded", source: "upload" },
    })) as { body: ProjectRow };
    const ready = await waitForStatus(ws, created.body.id, owner.cookie, ["ready", "error"]);
    expect(ready.status).toBe("ready");
    expect(ready.source).toBe("upload");

    const form = new FormData();
    form.append("file", new File(["hello\n"], "src/a.txt", { type: "text/plain" }));
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "img.png"));
    const uploaded = await call(`/api/workspaces/${ws}/projects/${ready.id}/files`, owner.cookie, {
      method: "POST",
      form,
    });
    expect(uploaded.body).toEqual({ written: 2 });
    const dir = join(projectsDir, ws, ready.id);
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("hello\n");
    expect([...readFileSync(join(dir, "img.png"))]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const escaping = new FormData();
    escaping.append("file", new File(["x"], "../outside.txt"));
    const refused = await call(`/api/workspaces/${ws}/projects/${ready.id}/files`, owner.cookie, {
      method: "POST",
      form: escaping,
    });
    expect(refused.status).toBe(422);
    expect(existsSync(join(projectsDir, ws, "outside.txt"))).toBe(false);
  }, 60_000);

  test("the deploy key: minted once, readable by members, rotated by admins, used for ssh clones", async () => {
    const owner = await signUp("Gus", "gus-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    const first = (await call(`/api/workspaces/${ws}/deploy-key`, owner.cookie)) as {
      status: number;
      body: { public_key: string; fingerprint: string };
    };
    expect(first.status).toBe(200);
    expect(first.body.public_key).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ perch-/);
    expect(first.body.fingerprint).toMatch(/^SHA256:/);
    const again = (await call(`/api/workspaces/${ws}/deploy-key`, owner.cookie)) as {
      body: { fingerprint: string };
    };
    expect(again.body.fingerprint).toBe(first.body.fingerprint);

    // A member reads it but cannot rotate it.
    const member = await signUp("Hal", "hal-projects@perch.test");
    const invited = (await call(`/api/workspaces/${ws}/invites`, owner.cookie, {
      method: "POST",
      json: { email: "hal-projects@perch.test", role: "member" },
    })) as { status: number; body: { accept_url: string } };
    expect(invited.status).toBe(201);
    const token = invited.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, member.cookie, { method: "POST" })).status,
    ).toBe(200);
    expect((await call(`/api/workspaces/${ws}/deploy-key`, member.cookie)).status).toBe(200);
    expect(
      (await call(`/api/workspaces/${ws}/deploy-key/rotate`, member.cookie, { method: "POST" }))
        .status,
    ).toBe(403);

    const rotated = (await call(`/api/workspaces/${ws}/deploy-key/rotate`, owner.cookie, {
      method: "POST",
    })) as { status: number; body: { fingerprint: string } };
    expect(rotated.status).toBe(200);
    expect(rotated.body.fingerprint).not.toBe(first.body.fingerprint);

    // An ssh clone hands the runner the private key (a stand-in runner captures the request).
    const privateKey = await decryptDeployKey(projectDeps(booted), ws);
    expect(privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    const calls: { method: string; params: unknown }[] = [];
    const stub: RunnerLink = {
      id: "0190f2d0-0000-7000-8000-00000000f00d",
      info: { name: "stub", kind: "hosted", capabilities: {}, versions: {} },
      async call(method, params) {
        calls.push({ method, params });
        return {
          path: "/x",
          defaultBranch: "main",
          head: "0123456789012345678901234567890123456789",
          config: null,
          devcontainer: null,
        };
      },
      onNotification: () => () => {},
      close: async () => {},
    };
    booted.runners.attach(stub, { workspaceId: ws });
    try {
      const created = (await call(`/api/workspaces/${ws}/projects/clone`, owner.cookie, {
        method: "POST",
        json: {
          name: "Over ssh",
          repo_url: "git@github.com:o/r.git",
          auth: { kind: "deploy_key" },
        },
      })) as { body: ProjectRow };
      const ready = await waitForStatus(ws, created.body.id, owner.cookie, ["ready", "error"]);
      expect(ready.status).toBe("ready");
      expect(ready.head).toBe("0123456789012345678901234567890123456789");
      const setup = calls.find((c) => c.method === "project.setup");
      expect(setup?.params).toMatchObject({
        source: { kind: "clone", url: "git@github.com:o/r.git", auth: { kind: "ssh", privateKey } },
      });
    } finally {
      await booted.runners.detach(stub.id);
    }
  }, 60_000);

  test("delete removes the directory and the row; other workspaces see nothing", async () => {
    const owner = await signUp("Ivy", "ivy-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    const created = (await call(`/api/workspaces/${ws}/projects`, owner.cookie, {
      method: "POST",
      json: { name: "Gone" },
    })) as { body: ProjectRow };
    const ready = await waitForStatus(ws, created.body.id, owner.cookie, ["ready", "error"]);
    const dir = join(projectsDir, ws, ready.id);
    expect(existsSync(dir)).toBe(true);

    const other = await signUp("Jo", "jo-projects@perch.test");
    const otherWs = await workspaceFor(other.cookie);
    expect(
      (await call(`/api/workspaces/${otherWs}/projects/${ready.id}`, other.cookie)).status,
    ).toBe(404);
    expect((await call(`/api/workspaces/${ws}/projects`, other.cookie)).status).toBe(404);

    const deleted = await call(`/api/workspaces/${ws}/projects/${ready.id}`, owner.cookie, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(existsSync(dir)).toBe(false);
    expect((await call(`/api/workspaces/${ws}/projects/${ready.id}`, owner.cookie)).status).toBe(
      404,
    );
    expect(events.some((e) => e.type === "project.deleted")).toBe(true);
  }, 60_000);

  test("without a runner the supervisor is asked and the project fails after the wait", async () => {
    const owner = await signUp("Kim", "kim-projects@perch.test");
    const ws = await workspaceFor(owner.cookie);
    const inprocess = booted.runners.list().find((r) => r.workspaceId === null);
    expect(inprocess).toBeDefined();
    if (!inprocess) return;
    const link = inprocess.link;
    booted.runners.detach(link.id);
    try {
      const { project, setup } = await createProject(
        projectDeps(booted),
        {
          workspaceId: ws,
          name: "Nowhere",
          source: { kind: "empty" },
          userId: owner.id,
          by: { actor: { type: "user", id: owner.id }, meta: { requestId: "test" } },
        },
        { runnerWaitMs: 100 },
      );
      expect(project.status).toBe("pending");
      const failed = await setup;
      expect(failed.status).toBe("error");
      expect(failed.statusMessage).toMatch(/no runner/);
    } finally {
      booted.runners.attach(link);
    }
  }, 60_000);
});
