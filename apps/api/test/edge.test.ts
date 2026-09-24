import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { errorResponseSchema } from "@perch/events";
import { hostAllowed, ProxyTrust, resolveClientAddress } from "../src/auth/edge.ts";
import type { Booted } from "../src/boot.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * The request edge (ADR-0172; review findings X-secu-05, A-co-10, X-secu-20, X-secu-19, A-co-22):
 * the Origin of cookie-authenticated writes and upgrades, the Host a request is addressed to, the
 * media type of a JSON body, and which address a request is recorded as coming from.
 */

let booted: Booted;
const BASE = "http://localhost:3000";
const PREVIEW_ORIGIN = "https://3000--ws.preview.example.com";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

/** A peer address for app.request, the way Bun.serve hands its server to the fetch handler. */
function fromPeer(address: string) {
  return {
    requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 1 }),
  };
}

function reason(body: unknown): unknown {
  return errorResponseSchema.parse(body).error.details?.reason;
}

let cookie = "";
let ws = "";

beforeAll(async () => {
  booted = await bootTestApp({
    PERCH_PREVIEW_DOMAIN: "preview.example.com",
    PERCH_TRUSTED_PROXIES: "10.0.0.0/8",
    PERCH_ALLOWED_HOSTS: "perch.internal",
  });
  const res = await booted.app.request(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Edge",
      email: "edge@example.test",
      password: "correct horse battery staple",
    }),
  });
  expect(res.status).toBe(200);
  cookie = cookiesFrom(res);
  const created = await booted.app.request(`${BASE}/api/workspaces`, {
    method: "POST",
    headers: { origin: BASE, cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Edge" }),
  });
  ws = ((await created.json()) as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await booted.close();
});

describe("a cookie-authenticated write or upgrade comes from Perch's own pages", () => {
  test("a body-less POST from a same-site preview is refused; from Perch it works", async () => {
    const path = `${BASE}/api/workspaces/${ws}/deploy-key/rotate`;
    const foreign = await booted.app.request(path, {
      method: "POST",
      headers: { cookie, origin: PREVIEW_ORIGIN, "content-type": "text/plain" },
    });
    expect(foreign.status).toBe(403);
    expect(reason(await foreign.json())).toBe("cross_origin");
    const noOrigin = await booted.app.request(path, {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "same-site" },
    });
    expect(noOrigin.status).toBe(403);
    const own = await booted.app.request(path, {
      method: "POST",
      headers: { cookie, origin: BASE },
    });
    expect(own.status).toBe(200);
  });

  test("a read is not an Origin matter, and a bearer caller is not a cookie", async () => {
    const read = await booted.app.request(`${BASE}/api/workspaces`, {
      headers: { cookie, origin: PREVIEW_ORIGIN },
    });
    expect(read.status).toBe(200);
    const minted = await booted.app.request(`${BASE}/api/me/tokens`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ name: "cli", scopes: ["admin"] }),
    });
    const { token } = (await minted.json()) as { token: string };
    const bearer = await booted.app.request(`${BASE}/api/workspaces/${ws}/deploy-key/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: PREVIEW_ORIGIN },
    });
    expect(bearer.status).toBe(200);
  });

  test("the /api/ws and terminal upgrades refuse another origin", async () => {
    const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13" };
    const socket = await booted.app.request(`${BASE}/api/ws`, {
      headers: { ...upgrade, cookie, origin: PREVIEW_ORIGIN },
    });
    expect(socket.status).toBe(403);
    expect(reason(await socket.json())).toBe("cross_origin");
    const terminal = await booted.app.request(
      `${BASE}/api/workspaces/${ws}/projects/${crypto.randomUUID()}/terminal`,
      { headers: { ...upgrade, cookie, origin: "null" } },
    );
    expect(terminal.status).toBe(403);
    expect(reason(await terminal.json())).toBe("cross_origin");
  });

  test("a JSON route refuses a body in another media type (415), not an internal error", async () => {
    const res = await booted.app.request(`${BASE}/api/workspaces`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "text/plain" },
      body: JSON.stringify({ name: "Sneaky" }),
    });
    expect(res.status).toBe(415);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("validation");
  });
});

describe("a request must be addressed to one of this instance's names (DNS rebinding)", () => {
  const setup = (host: string) =>
    booted.app.request(`http://${host}/api/instance`, { headers: { host } });

  test("a foreign name is refused, even for the public routes", async () => {
    const res = await setup("attacker.example:3000");
    expect(res.status).toBe(403);
    expect(reason(await res.json())).toBe("host_not_allowed");
    const wizard = await booted.app.request("http://attacker.example/api/setup", {
      method: "POST",
      headers: { host: "attacker.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(wizard.status).toBe(403);
  });

  test("the public name, loopback, IP literals, the preview domain and listed names are answered", async () => {
    for (const host of [
      "localhost:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      "192.168.0.5:3000",
      "perch.localhost",
      "perch.internal",
    ]) {
      expect((await setup(host)).status, host).toBe(200);
    }
    // A preview host goes to the preview proxy, which has no such workspace: not the host guard.
    const preview = await setup("3000--ws.preview.example.com");
    expect(preview.status).toBe(404);
  });

  test("the runner lane is reached by service name and is not refused for it", async () => {
    const res = await booted.app.request("http://api:3000/api/runner", {
      headers: { host: "api:3000" },
    });
    // Refused for having no connect token, which is the runner channel's own answer.
    expect(reason(await res.json())).toBe("runner_token_invalid");
  });

  test("hostAllowed reads the name, not the port or the case", () => {
    const env = booted.env;
    expect(hostAllowed("LOCALHOST:9999", env)).toBe(true);
    expect(hostAllowed("preview.example.com.evil.test", env)).toBe(false);
    expect(hostAllowed("evil-preview.example.com", env)).toBe(false);
    expect(hostAllowed("", env)).toBe(false);
  });
});

describe("the client address believes X-Forwarded-For only from a trusted proxy", () => {
  const trust = new ProxyTrust(["10.0.0.0/8"]);

  test("resolveClientAddress walks from the right past trusted proxies", () => {
    const forged = { forwardedFor: "203.0.113.9", realIp: undefined };
    expect(resolveClientAddress("198.51.100.7", forged, trust)).toBe("198.51.100.7");
    expect(
      resolveClientAddress(
        "10.0.0.2",
        { forwardedFor: "198.51.100.1, 203.0.113.9, 10.0.0.9", realIp: undefined },
        trust,
      ),
    ).toBe("203.0.113.9");
    expect(
      resolveClientAddress("10.0.0.2", { forwardedFor: undefined, realIp: "203.0.113.5" }, trust),
    ).toBe("203.0.113.5");
    expect(resolveClientAddress("::ffff:198.51.100.7", forged, trust)).toBe("198.51.100.7");
    expect(resolveClientAddress("127.0.0.1", forged, trust)).toBe("203.0.113.9");
    expect(resolveClientAddress(undefined, forged, trust)).toBeUndefined();
  });

  test("the audit row records the peer, not a header the peer wrote", async () => {
    const rename = (name: string, peer: string, forwardedFor: string) =>
      booted.app.request(
        `${BASE}/api/workspaces/${ws}`,
        {
          method: "PATCH",
          headers: {
            cookie,
            origin: BASE,
            "content-type": "application/json",
            "x-forwarded-for": forwardedFor,
          },
          body: JSON.stringify({ name }),
        },
        fromPeer(peer),
      );
    expect((await rename("Edge 2", "198.51.100.7", "203.0.113.66")).status).toBe(200);
    expect((await rename("Edge 3", "10.0.0.2", "203.0.113.77, 10.0.0.5")).status).toBe(200);
    const audit = (await (
      await booted.app.request(`${BASE}/api/workspaces/${ws}/audit?action=workspace.updated`, {
        headers: { cookie },
      })
    ).json()) as { rows: { ip: string | null }[] };
    // Newest first: the two renames above.
    expect(audit.rows.slice(0, 2).map((row) => row.ip)).toEqual(["203.0.113.77", "198.51.100.7"]);
  });
});

describe("a trusted proxy may be named rather than numbered", () => {
  test("names are looked up without failing on one that does not resolve", async () => {
    // Tests have no DNS to rely on: `localhost` resolves everywhere, `.invalid` nowhere (RFC 6761).
    const trust = new ProxyTrust(["localhost", "no-such-proxy.invalid"]);
    expect(trust.trusts("203.0.113.1")).toBe(false);
    await trust.refresh();
    expect(trust.trusts("127.0.0.1")).toBe(true);
    expect(trust.trusts("203.0.113.1")).toBe(false);
    expect(trust.trusts("not-an-address")).toBe(false);
  });
});
