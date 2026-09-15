import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessRunner } from "@perch/runner";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.18 (spec §5.6, §7.1): the preview proxy. A dev server on a runner port, reached through
 * Perch in both modes — `/p/{ws}/{port}/…` on Perch's origin, and `<port>--<slug>.<domain>` on its
 * own — with its HMR socket passed through and its bytes left alone.
 *
 * The stand-in dev server behaves the way Vite does where it matters: an HTML page, a WebSocket at
 * a path it chooses with a subprotocol it names, and a redirect to its own root. That is what the
 * proxy has to survive; a real Vite would add nothing the proxy can see.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let host = "";
let projectsDir = "";
let dev: ReturnType<typeof Bun.serve> | null = null;
let devPort = 0;

const DOMAIN = "preview.perch.test";
const PAGE = "<!doctype html><title>dev</title><h1>hello from the dev server</h1>";

beforeAll(async () => {
  // A dev server: a page, an HMR socket, a redirect home.
  dev = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/hmr") {
        // Vite's client asks for the "vite-hmr" subprotocol; answer in kind or it gives up.
        if (server.upgrade(request, { data: {} })) return undefined as unknown as Response;
        return new Response("expected a websocket", { status: 426 });
      }
      if (url.pathname === "/go") {
        return new Response(null, { status: 302, headers: { location: "/landed" } });
      }
      if (url.pathname === "/whoami") {
        return Response.json({
          host: request.headers.get("host"),
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
          forwardedHost: request.headers.get("x-forwarded-host"),
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

  // The gateway URLs come from PERCH_PUBLIC_URL, fixed at boot, so the port is chosen first.
  const reserved = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = reserved.port;
  reserved.stop(true);

  booted = await bootTestApp({
    PERCH_PUBLIC_URL: `http://127.0.0.1:${port}`,
    PERCH_PREVIEW_DOMAIN: DOMAIN,
  });
  projectsDir = mkdtempSync(join(tmpdir(), "perch-preview-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 50 }));
  running = serve(booted, { port, hostname: "127.0.0.1" });
  base = running.url;
  host = `127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await running.stop();
  dev?.stop(true);
  rmSync(projectsDir, { recursive: true, force: true });
});

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

/** One frame from a socket, or a failure that says which socket. */
function firstFrame(socket: WebSocket, what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no frame`)), 10_000);
    socket.addEventListener("message", (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(String(event.data));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${what}: socket error`));
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timer);
      reject(new Error(`${what}: closed ${event.code} ${event.reason}`));
    });
  });
}

describe("the preview proxy (task 1.18)", () => {
  let ws = "";
  let slug = "";
  let cookie = "";
  let project = "";
  let shareToken = "";
  let shareId = "";

  test("a dev server on a runner port is reachable in both modes, HMR included", async () => {
    const owner = await signUp("Wren", "wren-preview@perch.test");
    cookie = owner.cookie;
    const created = (await call("/api/workspaces", cookie, {
      method: "POST",
      json: { name: "Preview Nest" },
    })) as { body: { id: string; slug: string } };
    ws = created.body.id;
    slug = created.body.slug;
    project = await readyProject(cookie, ws, "Site");

    // Path mode: Perch's own origin, no DNS needed.
    const pathMode = await fetch(`${base}/p/${ws}/${devPort}/index.html`, { headers: { cookie } });
    expect(pathMode.status).toBe(200);
    expect(await pathMode.text()).toBe(PAGE);

    // Wildcard mode: the dev server's own origin, decided on the Host header.
    const hostMode = await fetch(`${base}/index.html`, {
      headers: { cookie, host: `${devPort}--${slug}.${DOMAIN}` },
    });
    expect(hostMode.status).toBe(200);
    expect(await hostMode.text()).toBe(PAGE);

    // The dev server is asked as itself, and never handed Perch's session (AGENTS.md §1.6).
    const seen = (await (
      await fetch(`${base}/p/${ws}/${devPort}/whoami`, { headers: { cookie } })
    ).json()) as Record<string, string | null>;
    expect(seen.host).toBe(`127.0.0.1:${devPort}`);
    expect(seen.cookie).toBeNull();
    expect(seen.authorization).toBeNull();
    expect(seen.forwardedHost).toBe(host);

    // A redirect to the dev server's root lands under the prefix, not on Perch's own root.
    const redirected = await fetch(`${base}/p/${ws}/${devPort}/go`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe(`/p/${ws}/${devPort}/landed`);

    // HMR in path mode: the socket, its subprotocol, and frames both ways.
    const byPath = new WebSocket(`${base.replace("http", "ws")}/p/${ws}/${devPort}/hmr`, {
      headers: { cookie },
      protocols: ["vite-hmr"],
    } as unknown as string[]);
    expect(await firstFrame(byPath, "path-mode hmr")).toBe('{"type":"connected"}');
    const echoed = new Promise<string>((resolve) => {
      byPath.addEventListener("message", (event: MessageEvent) => resolve(String(event.data)));
    });
    byPath.send("ping");
    expect(await echoed).toBe("echo:ping");
    byPath.close();

    // HMR in wildcard mode: the same socket through the other door.
    const byHost = new WebSocket(`${base.replace("http", "ws")}/hmr`, {
      headers: { cookie, host: `${devPort}--${slug}.${DOMAIN}` },
      protocols: ["vite-hmr"],
    } as unknown as string[]);
    expect(await firstFrame(byHost, "wildcard-mode hmr")).toBe('{"type":"connected"}');
    byHost.close();
  }, 60_000);

  test("the listing shows the port, and only members may open it", async () => {
    // ports.changed has to have caught up for the port to be listed.
    let ports: { port: number; url: string; configured: boolean }[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = (await call(`/api/workspaces/${ws}/projects/${project}/previews`, cookie)) as {
        body: { ports: typeof ports };
      };
      ports = res.body.ports;
      if (ports.some((p) => p.port === devPort)) break;
      await Bun.sleep(100);
    }
    const found = ports.find((p) => p.port === devPort);
    expect(found).toBeDefined();
    // Perch answers preview hostnames on its own listener, so its port comes along.
    expect(found?.url).toBe(`http://${devPort}--${slug}.${DOMAIN}:${new URL(base).port}/`);

    // Signed out is not a member.
    const anonymous = await fetch(`${base}/p/${ws}/${devPort}/`);
    expect(anonymous.status).toBe(403);

    // Somebody else's session is not a membership either.
    const stranger = await signUp("Stranger", "stranger-preview@perch.test");
    const refused = await fetch(`${base}/p/${ws}/${devPort}/`, {
      headers: { cookie: stranger.cookie },
    });
    expect(refused.status).toBe(403);

    // The proxy reaches only what a runner is serving (spec §5.6) — never the database.
    const forbiddenPort = await fetch(`${base}/p/${ws}/5432/`, { headers: { cookie } });
    expect(forbiddenPort.status).toBe(403);
  }, 30_000);

  test("a share link opens the preview for someone with no session, and no inspector", async () => {
    const created = (await call(
      `/api/workspaces/${ws}/projects/${project}/previews/${devPort}/share`,
      cookie,
      { method: "POST", json: { public: true, expires_in_hours: 2 } },
    )) as { status: number; body: { id: string; url: string; expires_at: string } };
    expect(created.status).toBe(201);
    shareId = created.body.id;
    const url = new URL(created.body.url);
    shareToken = url.searchParams.get("perch_share") ?? "";
    expect(shareToken).not.toBe("");
    expect(url.host).toBe(`${devPort}--${slug}.${DOMAIN}:${new URL(base).port}`);

    // The link, opened by a browser that has never seen Perch.
    const opened = await fetch(`${base}/?perch_share=${shareToken}`, {
      headers: { host: `${devPort}--${slug}.${DOMAIN}` },
    });
    expect(opened.status).toBe(200);
    const body = await opened.text();
    // Byte for byte what the dev server said: §5.6 — a share never carries the inspector.
    expect(body).toBe(PAGE);
    expect(body).not.toContain("perch-inspector");
    expect(body).not.toContain("data-perch-src");

    // The token becomes a cookie, so the dev server's own links keep working.
    const setCookie = opened.headers.getSetCookie().join("; ");
    expect(setCookie).toContain("perch_preview_share=");
    const followed = await fetch(`${base}/about`, {
      headers: {
        host: `${devPort}--${slug}.${DOMAIN}`,
        cookie: `perch_preview_share=${shareToken}`,
      },
    });
    expect(followed.status).toBe(200);

    // One port, not the runner: a share is not a key to everything listening.
    const elsewhere = await fetch(`${base}/p/${ws}/${devPort + 1}/?perch_share=${shareToken}`);
    expect(elsewhere.status).toBe(403);

    // The listing carries live shares, never their tokens.
    const listed = (await call(`/api/workspaces/${ws}/projects/${project}/previews`, cookie)) as {
      body: { shares: { id: string; port: number }[] };
    };
    expect(listed.body.shares.map((s) => s.id)).toContain(shareId);
    expect(JSON.stringify(listed.body)).not.toContain(shareToken);
  }, 30_000);

  test("revoking a share closes the door", async () => {
    const revoked = await call(`/api/preview-shares/${shareId}`, cookie, { method: "DELETE" });
    expect(revoked.status).toBe(204);

    const refused = await fetch(`${base}/?perch_share=${shareToken}`, {
      headers: { host: `${devPort}--${slug}.${DOMAIN}` },
    });
    expect(refused.status).toBe(403);
    // The cookie a previous visit kept is no better than the token it came from.
    const stale = await fetch(`${base}/`, {
      headers: {
        host: `${devPort}--${slug}.${DOMAIN}`,
        cookie: `perch_preview_share=${shareToken}`,
      },
    });
    expect(stale.status).toBe(403);

    // Revoking twice is a conflict, not a second revocation.
    const again = await call(`/api/preview-shares/${shareId}`, cookie, { method: "DELETE" });
    expect(again.status).toBe(409);
  }, 30_000);
});
