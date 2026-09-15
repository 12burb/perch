import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@perch/db";
import { connectRunner } from "@perch/runner";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { createRunner, mintRunnerToken } from "../src/services/runners.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.19 (spec §5.6, §7.6 `http.open`): the preview tunnel. A laptop runner is somewhere the api
 * cannot route to, so a preview on it travels back through the WebSocket the runner opened.
 *
 * The runner here is connected exactly the way `perch runner connect` connects one — a real socket
 * to /api/runner with a real token — and it reports no `preview_host`, which is what puts the
 * request on the tunnel lane rather than the direct one. The dev server it serves is a real server
 * on a real port, with a real HMR-shaped socket.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let workspaceId = "";
let userId = "";
let cookie = "";
let runnerId = "";
let client: ReturnType<typeof connectRunner> | null = null;
let dev: ReturnType<typeof Bun.serve> | null = null;
let devPort = 0;
let projectsDir = "";

const PAGE = "<!doctype html><title>laptop</title><h1 id=app>from the laptop</h1>";

beforeAll(async () => {
  // The "laptop's" dev server: a page, an echoing socket, a redirect, and a body echo.
  dev = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/hmr") {
        if (server.upgrade(request, { data: {} })) return undefined as unknown as Response;
        return new Response("expected a websocket", { status: 426 });
      }
      if (url.pathname === "/echo") {
        return new Response(request.body, { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/whoami") {
        return Response.json({
          host: request.headers.get("host"),
          cookie: request.headers.get("cookie"),
          forwardedHost: request.headers.get("x-forwarded-host"),
        });
      }
      if (url.pathname === "/bytes") {
        // Something that is not text, to prove the tunnel is not mangling bodies.
        return new Response(new Uint8Array([0, 159, 146, 150, 255, 0, 1, 2]), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "connected" }));
      },
      message(ws, message) {
        ws.send(`echo:${String(message)}`);
      },
    },
  });
  devPort = dev.port as number;

  booted = await bootTestApp({}, { runnerChannel: { heartbeatMs: 500, requestTimeoutMs: 5_000 } });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  projectsDir = mkdtempSync(join(tmpdir(), "perch-tunnel-"));

  const [workspace] = await booted.db.db.select().from(schema.workspaces).limit(1);
  if (!workspace) throw new Error("setup created no workspace");
  workspaceId = workspace.id;
  const [membership] = await booted.db.db
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.workspaceId, workspaceId))
    .limit(1);
  if (!membership) throw new Error("setup created no membership");
  userId = membership.userId;

  // A laptop: kind "local", no preview host, its own projects directory.
  const runner = await createRunner(booted.db.db, {
    workspaceId,
    kind: "local",
    name: "pending",
    ownerUserId: userId,
  });
  runnerId = runner.id;
  const { token } = await mintRunnerToken(booted.db.db, runner.id);
  client = connectRunner({
    apiUrl: base,
    token,
    name: "a laptop",
    kind: "local",
    ownerUserId: userId,
    // A laptop is behind NAT: it does not tell the api where its ports are, and the api must not
    // guess. This is what puts the request on the tunnel.
    previewHost: null,
    portsIntervalMs: 100,
    reconnect: false,
    handlerOptions: { projects: { root: projectsDir } },
  });
  await client.registered();

  // Sign in as the workspace's admin, which is who the preview runs as.
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: "admin@perch.test", password: "admin-passphrase-for-tests" }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}, 60_000);

afterAll(async () => {
  await client?.close();
  await running.stop();
  dev?.stop(true);
  rmSync(projectsDir, { recursive: true, force: true });
});

/** The registry has to have seen the port before the proxy will reach for it. */
async function untilListening(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = booted.runners.get(runnerId);
    if (entry?.ports.some((p) => p.port === port)) return;
    await Bun.sleep(100);
  }
  throw new Error(`the runner never reported port ${port}`);
}

describe("the preview tunnel (task 1.19)", () => {
  test("the laptop is on the tunnel lane, not the direct one", async () => {
    const entry = booted.runners.get(runnerId);
    expect(entry?.link.info.kind).toBe("local");
    // Nothing to route to: the api has no address for this runner's ports.
    expect(entry?.link.info.preview_host).toBeUndefined();
    const reach = booted.previews.reach(workspaceId, devPort);
    expect(reach.kind).toBe("tunnel");
    expect(reach.runnerId).toBe(runnerId);
  }, 30_000);

  test("a page, a body, and bytes all come back through the runner's own socket", async () => {
    await untilListening(devPort);
    const page = await fetch(`${base}/p/${workspaceId}/${devPort}/index.html`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe(PAGE);

    // A request body crosses the tunnel in order and comes back unchanged.
    const echoed = await fetch(`${base}/p/${workspaceId}/${devPort}/echo`, {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: "a".repeat(200_000),
    });
    expect(echoed.status).toBe(200);
    expect((await echoed.text()).length).toBe(200_000);

    // A body that is not text survives too: the frames carry bytes, not strings.
    const bytes = await fetch(`${base}/p/${workspaceId}/${devPort}/bytes`, { headers: { cookie } });
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([
      0, 159, 146, 150, 255, 0, 1, 2,
    ]);

    // The dev server is asked as itself, and never handed Perch's session (AGENTS.md §1.6).
    const seen = (await (
      await fetch(`${base}/p/${workspaceId}/${devPort}/whoami`, { headers: { cookie } })
    ).json()) as Record<string, string | null>;
    expect(seen.host).toBe(`127.0.0.1:${devPort}`);
    expect(seen.cookie).toBeNull();
  }, 60_000);

  test("HMR: the socket is relayed frame for frame through the same connection", async () => {
    await untilListening(devPort);
    const socket = new WebSocket(`${base.replace("http", "ws")}/p/${workspaceId}/${devPort}/hmr`, {
      headers: { cookie },
      protocols: ["vite-hmr"],
    } as unknown as string[]);
    const frames: string[] = [];
    const first = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame arrived")), 15_000);
      socket.addEventListener("message", (event: MessageEvent) => {
        frames.push(String(event.data));
        if (frames.length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the tunnelled socket failed"));
      });
      socket.addEventListener("open", () => socket.send("ping"));
    });
    await first;
    expect(frames[0]).toBe('{"type":"connected"}');
    expect(frames[1]).toBe("echo:ping");
    socket.close();
  }, 60_000);

  test("a port the laptop is not serving fails as a preview, not as a hang", async () => {
    // Port 1 needs root to bind, so nothing of the laptop's is on it.
    const answer = await fetch(`${base}/p/${workspaceId}/1/`, { headers: { cookie } });
    expect([409, 502]).toContain(answer.status);
    const body = (await answer.json()) as { error: { code: string } };
    expect(["conflict", "upstream_failed"]).toContain(body.error.code);
  }, 30_000);
});
