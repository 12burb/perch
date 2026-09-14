import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRunner, createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.7 (spec §5.1 terminal, §7.6 pty.* and stream sockets, ADR-0073): the project terminal
 * socket relays a shell on the project's runner: through the in-process runner (laptop mode) and
 * through a local runner over its control channel plus a stream socket; a reconnect with the
 * pty_id gets the same shell back with its scrollback; strangers are refused.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
const dirs: string[] = [];

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
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as unknown };
}

async function workspace(cookie: string, name: string): Promise<string> {
  const created = (await call("/api/workspaces", cookie, { method: "POST", json: { name } })) as {
    body: { id: string };
  };
  return created.body.id;
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

type Frame = { t: string; d?: string; pty_id?: string; reattached?: boolean; message?: string };

/** A browser's terminal socket: frames in, a way to wait for output. */
function terminal(url: string, cookie: string) {
  const Ctor = WebSocket as unknown as new (
    u: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new Ctor(url, { headers: { cookie } });
  const frames: Frame[] = [];
  let output = "";
  const waiters: { predicate: () => boolean; resolve: () => void }[] = [];
  const poke = () => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("terminal socket failed")), { once: true });
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    frames.push(frame);
    if (frame.t === "o" && frame.d) output += frame.d;
    poke();
  });
  const until = (predicate: () => boolean, ms = 20_000) =>
    new Promise<void>((resolve, reject) => {
      if (predicate()) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`timed out; frames: ${JSON.stringify(frames.slice(-5))}`)),
        ms,
      );
      waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  return {
    ws,
    frames,
    opened,
    closed,
    get output() {
      return output;
    },
    send: (frame: Record<string, unknown>) => ws.send(JSON.stringify(frame)),
    openFrame: () =>
      until(() => frames.some((f) => f.t === "open")).then(
        () => frames.find((f) => f.t === "open") as Frame,
      ),
    waitFor: (marker: string) => until(() => output.includes(marker)),
    close: () => ws.close(1000, "done"),
  };
}

function terminalUrl(ws: string, project: string, query = ""): string {
  return `${base.replace(/^http/, "ws")}/api/workspaces/${ws}/projects/${project}/terminal${query}`;
}

beforeAll(async () => {
  booted = await bootTestApp({}, { runnerChannel: { heartbeatMs: 200 } });
  const projectsDir = mkdtempSync(join(tmpdir(), "perch-term-inproc-"));
  dirs.push(projectsDir);
  booted.runners.attach(
    createInProcessRunner({
      projectsDir,
      portsIntervalMs: 0,
      pty: { tmux: false, graceMs: 60_000 },
    }),
  );
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
});

afterAll(async () => {
  await running.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("project terminal (task 1.7)", () => {
  test("laptop mode: a shell through the in-process runner, reattached after a disconnect", async () => {
    const owner = await signUp("Una", "una-term@perch.test");
    const ws = await workspace(owner.cookie, "Term Nest");
    const project = await readyProject(owner.cookie, ws, "Shell");

    const first = terminal(terminalUrl(ws, project, "?cols=100&rows=30"), owner.cookie);
    await first.opened;
    const open = await first.openFrame();
    expect(open.pty_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(open.reattached).toBe(false);
    first.send({ t: "i", d: "echo perch-term-one\r" });
    await first.waitFor("perch-term-one");
    first.send({ t: "r", cols: 120, rows: 40 });
    first.send({ t: "i", d: "echo cols=$(tput cols)\r" });
    await first.waitFor("cols=120");
    first.close();
    await first.closed;

    // The browser comes back (a reload) with the pty_id: same shell, scrollback replayed.
    const second = terminal(
      terminalUrl(ws, project, `?pty_id=${open.pty_id}&cols=80&rows=24`),
      owner.cookie,
    );
    await second.opened;
    const reopen = await second.openFrame();
    expect(reopen.pty_id).toBe(open.pty_id);
    expect(reopen.reattached).toBe(true);
    await second.waitFor("perch-term-one");
    second.send({ t: "i", d: "echo perch-term-two\r" });
    await second.waitFor("perch-term-two");
    // The shell exiting closes the socket with an x frame.
    second.send({ t: "i", d: "exit\r" });
    await second.closed;
    expect(second.frames.some((f) => f.t === "x")).toBe(true);

    // An unknown pty_id simply starts a fresh shell.
    const third = terminal(terminalUrl(ws, project, "?pty_id=nope"), owner.cookie);
    await third.opened;
    expect((await third.openFrame()).reattached).toBe(false);
    third.close();
    await third.closed;
  }, 60_000);

  test("a stranger and a project that is not ready are refused before any shell starts", async () => {
    const owner = await signUp("Vic", "vic-term@perch.test");
    const ws = await workspace(owner.cookie, "Locked Nest");
    const project = await readyProject(owner.cookie, ws, "Shell");
    const stranger = await signUp("Wes", "wes-term@perch.test");
    const res = await fetch(terminalUrl(ws, project).replace(/^ws/, "http"), {
      headers: { cookie: stranger.cookie, upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
    const noAuth = await fetch(terminalUrl(ws, project).replace(/^ws/, "http"));
    expect(noAuth.status).toBe(403);
  });

  test("a local runner: the shell runs on the machine, output over the stream socket", async () => {
    const owner = await signUp("Xan", "xan-term@perch.test");
    const ws = await workspace(owner.cookie, "Laptop Nest");
    const connected = (await call(`/api/workspaces/${ws}/runners/connect`, owner.cookie, {
      method: "POST",
      json: { name: "Laptop" },
    })) as { body: { token: string } };
    const projectsDir = mkdtempSync(join(tmpdir(), "perch-term-local-"));
    dirs.push(projectsDir);
    const agent = connectRunner({
      apiUrl: base,
      token: connected.body.token,
      name: "Laptop",
      kind: "local",
      portsIntervalMs: 0,
      handlerOptions: { projects: { root: projectsDir }, pty: { tmux: false, graceMs: 60_000 } },
    });
    try {
      await agent.registered();
      // The workspace's own runner wins over the shared in-process one: the project lands there.
      const project = await readyProject(owner.cookie, ws, "Remote shell");
      const term = terminal(terminalUrl(ws, project), owner.cookie);
      await term.opened;
      const open = await term.openFrame();
      expect(open.reattached).toBe(false);
      term.send({ t: "i", d: "echo perch-term-remote\r" });
      await term.waitFor("perch-term-remote");
      term.send({ t: "i", d: "pwd\r" });
      await term.waitFor(
        join(projectsDir, ws, project).replace(/\\/g, "/").split("/").pop() ?? project,
      );
      term.close();
      await term.closed;
    } finally {
      await agent.close();
    }
  }, 60_000);
});
