import { describe, expect, test } from "bun:test";
import {
  downstreamResponse,
  hashShareToken,
  mintShareToken,
  parsePreviewHost,
  parsePreviewPath,
  parsePreviewRequest,
  previewUrl,
  proxyRequest,
  rewriteLocation,
  SHARE_QUERY,
  type ShareRecord,
  shareAllows,
  shareUrl,
  upstreamRequest,
  upstreamWebSocketUrl,
} from "../src/index.ts";

/**
 * Task 1.18 (spec §5.6, §7.1): where a preview lives, what the proxy passes through, and what a
 * share link is allowed to open.
 */

const DOMAIN = "preview.perch.test";

describe("where a preview lives", () => {
  test("wildcard mode reads the port and the workspace off the hostname", () => {
    expect(parsePreviewHost(`5173--nest.${DOMAIN}`, DOMAIN, "/src/App.tsx")).toEqual({
      workspace: "nest",
      port: 5173,
      path: "/src/App.tsx",
      mode: "host",
    });
    // A Host header carries the port when it is not the scheme's default.
    expect(parsePreviewHost(`3000--nest.${DOMAIN}:8443`, DOMAIN)?.port).toBe(3000);
    // A slug may contain a single dash; the double dash is what splits.
    expect(parsePreviewHost(`8080--my-nest.${DOMAIN}`, DOMAIN)?.workspace).toBe("my-nest");
    expect(parsePreviewHost(`5173--NEST.${DOMAIN.toUpperCase()}`, DOMAIN)?.workspace).toBe("nest");
  });

  test("anything that is not a preview hostname is not one", () => {
    expect(parsePreviewHost(`perch.test`, DOMAIN)).toBeNull();
    expect(parsePreviewHost(`nest.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parsePreviewHost(`0--nest.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parsePreviewHost(`99999--nest.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parsePreviewHost(`5173--.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parsePreviewHost(`x5173--nest.${DOMAIN}`, DOMAIN)).toBeNull();
    // A lookalike domain is not the domain.
    expect(parsePreviewHost(`5173--nest.evil-${DOMAIN}`, DOMAIN)).toBeNull();
    // No preview domain configured means no wildcard mode at all.
    expect(parsePreviewHost(`5173--nest.${DOMAIN}`, undefined)).toBeNull();
  });

  test("path mode keeps the prefix so a redirect can be moved onto it", () => {
    expect(parsePreviewPath("/p/ws-1/5173/src/App.tsx", "?raw")).toEqual({
      workspace: "ws-1",
      port: 5173,
      path: "/src/App.tsx?raw",
      mode: "path",
      prefix: "/p/ws-1/5173",
    });
    expect(parsePreviewPath("/p/ws-1/5173")?.path).toBe("/");
    expect(parsePreviewPath("/p/ws-1/5173/")?.path).toBe("/");
    expect(parsePreviewPath("/api/health")).toBeNull();
    expect(parsePreviewPath("/p/ws-1")).toBeNull();
    expect(parsePreviewPath("/p/ws-1/not-a-port/")).toBeNull();
  });

  test("one call handles whichever mode the request arrived in", () => {
    const hosted = parsePreviewRequest(
      new URL(`https://5173--nest.${DOMAIN}/index.html`),
      `5173--nest.${DOMAIN}`,
      DOMAIN,
    );
    expect(hosted?.mode).toBe("host");
    const pathed = parsePreviewRequest(
      new URL("https://perch.test/p/ws-1/5173/index.html"),
      "perch.test",
      DOMAIN,
    );
    expect(pathed?.mode).toBe("path");
  });

  test("a URL is only offered in a mode the instance can actually serve", () => {
    const base = { publicUrl: "https://perch.test", workspaceId: "ws-1", port: 5173 };
    expect(previewUrl({ ...base, previewDomain: DOMAIN, workspaceSlug: "nest" })).toBe(
      `https://5173--nest.${DOMAIN}/`,
    );
    // No preview domain, or a slug DNS could not carry: path mode.
    expect(previewUrl({ ...base, workspaceSlug: "nest" })).toBe("https://perch.test/p/ws-1/5173/");
    expect(previewUrl({ ...base, previewDomain: DOMAIN, workspaceSlug: "a nest!" })).toBe(
      "https://perch.test/p/ws-1/5173/",
    );
    // Laptop mode is plain HTTP, and a preview of it should not claim otherwise.
    expect(
      previewUrl({
        ...base,
        publicUrl: "http://localhost:3000",
        previewDomain: DOMAIN,
        workspaceSlug: "nest",
      }),
    ).toBe(`http://5173--nest.${DOMAIN}/`);
    expect(previewUrl({ ...base, path: "/about" })).toBe("https://perch.test/p/ws-1/5173/about");
  });

  test("a share link is that URL with its token on it", () => {
    const url = new URL(
      shareUrl({
        publicUrl: "https://perch.test",
        workspaceId: "ws-1",
        port: 5173,
        path: "/about",
        token: "tok_123",
      }),
    );
    expect(url.pathname).toBe("/p/ws-1/5173/about");
    expect(url.searchParams.get(SHARE_QUERY)).toBe("tok_123");
  });
});

describe("the proxy", () => {
  const target = { host: "127.0.0.1", port: 5173 };

  test("the dev server is asked as itself, without Perch's credentials", () => {
    const request = new Request("https://perch.test/p/ws-1/5173/index.html", {
      headers: {
        cookie: "perch.session=secret",
        authorization: "Bearer perch-token",
        accept: "text/html",
        "accept-encoding": "gzip",
        connection: "keep-alive",
        host: "perch.test",
      },
    });
    const out = upstreamRequest({ target, path: "/index.html", request });
    expect(out.url).toBe("http://127.0.0.1:5173/index.html");
    // AGENTS.md §1.6 in the small: Perch's session cookie is Perch's.
    expect(out.headers.get("cookie")).toBeNull();
    expect(out.headers.get("authorization")).toBeNull();
    // Hop-by-hop headers are this hop's, not the next one's.
    expect(out.headers.get("connection")).toBeNull();
    expect(out.headers.get("accept")).toBe("text/html");
    expect(out.headers.get("host")).toBe("127.0.0.1:5173");
    expect(out.headers.get("x-forwarded-host")).toBe("perch.test");
    expect(out.headers.get("x-forwarded-proto")).toBe("https");
  });

  test("a redirect to the dev server's own origin lands under the prefix", () => {
    const options = { target, prefix: "/p/ws-1/5173" };
    expect(rewriteLocation("http://127.0.0.1:5173/login", options)).toBe("/p/ws-1/5173/login");
    expect(rewriteLocation("/login", options)).toBe("/p/ws-1/5173/login");
    // Somewhere else entirely stays somewhere else entirely.
    expect(rewriteLocation("https://accounts.google.com/o/oauth2", options)).toBeNull();
    expect(rewriteLocation("//evil.test/", options)).toBeNull();
    // Wildcard mode has its own origin: nothing to rewrite.
    expect(rewriteLocation("/login", { target })).toBeNull();
  });

  test("the answer comes back whole, minus what was only for this hop", () => {
    const upstream = new Response("<!doctype html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "transfer-encoding": "chunked",
        "set-cookie": "sid=1; Path=/",
      },
    });
    const out = downstreamResponse(upstream, { target });
    expect(out.headers.get("content-type")).toBe("text/html");
    expect(out.headers.get("transfer-encoding")).toBeNull();
    expect(out.headers.get("set-cookie")).toBe("sid=1; Path=/");
    expect(out.headers.get("cache-control")).toBe("no-store");
  });

  test("a real round trip against a real server, streamed", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/echo") {
          return new Response(request.body, { headers: { "content-type": "text/plain" } });
        }
        if (url.pathname === "/go") {
          return new Response(null, { status: 302, headers: { location: "/landed" } });
        }
        return new Response(`hello from ${url.pathname}`, {
          headers: { "content-type": "text/plain" },
        });
      },
    });
    const live = { host: "127.0.0.1", port: server.port as number };
    try {
      const answered = await proxyRequest({
        target: live,
        path: "/index.html",
        request: new Request("https://perch.test/p/ws-1/1/index.html"),
      });
      expect(await answered.text()).toBe("hello from /index.html");

      const posted = await proxyRequest({
        target: live,
        path: "/echo",
        request: new Request("https://perch.test/p/ws-1/1/echo", {
          method: "POST",
          body: "round trip",
        }),
      });
      expect(await posted.text()).toBe("round trip");

      const redirected = await proxyRequest({
        target: live,
        path: "/go",
        request: new Request("https://perch.test/p/ws-1/1/go"),
        prefix: "/p/ws-1/1",
      });
      expect(redirected.status).toBe(302);
      expect(redirected.headers.get("location")).toBe("/p/ws-1/1/landed");
    } finally {
      server.stop(true);
    }
  });

  test("nothing listening is a named failure, not a hung request", async () => {
    // Port 1 needs root to bind, so nothing of ours is on it.
    await expect(
      proxyRequest({
        target: { host: "127.0.0.1", port: 1 },
        path: "/",
        request: new Request("https://perch.test/p/ws-1/1/"),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/nothing is listening on port 1/);
  });

  test("HMR knows where to connect", () => {
    expect(upstreamWebSocketUrl(target, "/?token=abc")).toBe("ws://127.0.0.1:5173/?token=abc");
  });
});

describe("share links", () => {
  test("Perch keeps the hash, the holder keeps the token", async () => {
    const token = mintShareToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mintShareToken()).not.toBe(token);
    const hash = await hashShareToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(await hashShareToken(token)).toBe(hash);
  });

  test("a share opens one port in one workspace until it expires", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const share: ShareRecord = {
      workspaceId: "ws-1",
      projectId: "p-1",
      runnerId: "r-1",
      port: 5173,
      path: "/",
      public: true,
      expiresAt: new Date("2026-09-16T12:00:00Z"),
      revokedAt: null,
    };
    expect(shareAllows(share, { workspaceId: "ws-1", port: 5173 }, now)).toEqual({ ok: true });
    expect(shareAllows(share, { workspaceId: "ws-1", port: 22 }, now)).toEqual({
      ok: false,
      reason: "wrong_port",
    });
    expect(shareAllows(share, { workspaceId: "ws-2", port: 5173 }, now)).toEqual({
      ok: false,
      reason: "wrong_workspace",
    });
    expect(
      shareAllows(share, { workspaceId: "ws-1", port: 5173 }, new Date("2026-09-17T00:00:00Z")),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      shareAllows({ ...share, revokedAt: now }, { workspaceId: "ws-1", port: 5173 }, now),
    ).toEqual({ ok: false, reason: "revoked" });
  });
});
