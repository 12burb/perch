import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusEvent } from "@perch/events";
import type { Booted } from "../src/boot.ts";
import { silentLogger } from "../src/logging.ts";
import { getConnection } from "../src/repos/connections.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { ConnectionsService } from "../src/services/connections.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * The OAuth lanes, hardened (ADR-0173; spec §3.5):
 *
 * - a callback finishes only for the person who started it, on the provider it was started for;
 * - the workspace's registered app — and its secret — is only ever used with the manifest's own MCP
 *   server, never with one a member typed;
 * - discovery refuses a document that describes some other resource or issuer;
 * - an MCP-lane connection refreshes, with the client a server registered for it, one refresh at a
 *   time, and a refresh token another process already spent is not a dead connection;
 * - disconnecting hands the tokens back to the provider.
 *
 * Two stand-in providers on this machine: `home`, which the connector's manifest names, and
 * `elsewhere`, a server a member types in themselves.
 */

type Seen = {
  method: string;
  path: string;
  authorization: string | null;
  form: URLSearchParams | null;
  body: string;
};

type Knobs = {
  expiresIn: number;
  prmResource?: string | undefined;
  issuer?: string | undefined;
  tokenEndpoint?: string | undefined;
  revokeStatus: number;
};

type Provider = {
  origin: string;
  seen: Seen[];
  knobs: Knobs;
  stop: () => void;
};

/** A provider: an MCP server's metadata, an authorization server, and a REST API. */
function standIn(): Provider {
  const seen: Seen[] = [];
  const knobs: Knobs = { expiresIn: 3600, revokeStatus: 200 };
  const live = new Set<string>();
  let minted = 0;
  let registered = 0;
  const mint = () => {
    minted += 1;
    live.add(`refresh-${minted}`);
    return Response.json({
      access_token: `access-${minted}`,
      refresh_token: `refresh-${minted}`,
      token_type: "Bearer",
      expires_in: knobs.expiresIn,
      scope: "read",
    });
  };
  let port = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${port}`;
      const body = await request.text();
      const form = (request.headers.get("content-type") ?? "").includes("x-www-form-urlencoded")
        ? new URLSearchParams(body)
        : null;
      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        form,
        body,
      });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: knobs.prmResource ?? `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["read"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: knobs.issuer ?? origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: knobs.tokenEndpoint ?? `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        registered += 1;
        return Response.json({
          client_id: `dcr-${registered}`,
          client_secret: `dcr-secret-${registered}`,
        });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        if (form?.get("grant_type") === "authorization_code") return mint();
        if (form?.get("grant_type") === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          if (!live.has(presented)) {
            // A refresh token spent already. Answered late, so the refresh that spent it has
            // landed by the time this refusal arrives — the order a real race usually ends in.
            await Bun.sleep(300);
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          live.delete(presented);
          await Bun.sleep(100);
          return mint();
        }
      }
      if (url.pathname === "/revoke") return new Response(null, { status: knobs.revokeStatus });
      if (url.pathname === "/whoami" || url.pathname === "/user") {
        return Response.json({ login: "ada-at-provider" });
      }
      if (url.pathname === "/login/oauth/access_token") {
        return Response.json({ access_token: "gh-access", token_type: "bearer", scope: "repo" });
      }
      if (url.pathname.startsWith("/applications/") && request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  port = server.port ?? 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    knobs,
    stop: () => server.stop(true),
  };
}

let booted: Booted;
let running: RunningServer;
let base = "";
let dir = "";
let home: Provider;
let elsewhere: Provider;
const created: BusEvent<"connection.created">[] = [];

beforeAll(async () => {
  home = standIn();
  elsewhere = standIn();
  // Two connectors that exist only as files: one whose MCP server is `home`, and a GitHub whose
  // OAuth app and API are `home` too (a file with a built-in's id replaces it).
  dir = mkdtempSync(join(tmpdir(), "perch-oauth-"));
  mkdirSync(join(dir, "acme-mcp"));
  writeFileSync(
    join(dir, "acme-mcp", "manifest.yaml"),
    `id: acme-mcp
name: Acme MCP
auth:
  - mcp_oauth
  - token
api_base: ${home.origin}
test_path: /whoami
mcp_url: ${home.origin}/mcp
`,
  );
  mkdirSync(join(dir, "github"));
  writeFileSync(
    join(dir, "github", "manifest.yaml"),
    `id: github
name: GitHub
auth:
  - oauth2
  - token
api_base: ${home.origin}
test_path: /user
account_field: login
oauth:
  authorize_url: ${home.origin}/login/oauth/authorize
  token_url: ${home.origin}/login/oauth/access_token
  scopes:
    - repo
  scope_separator: " "
  refresh: false
`,
  );
  booted = await bootTestApp({ PERCH_CONNECTORS_DIR: dir });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  booted.bus.subscribe("connection.created", (event) => {
    created.push(event);
  });
}, 60_000);

afterAll(async () => {
  await running.stop();
  home.stop();
  elsewhere.stop();
  rmSync(dir, { recursive: true, force: true });
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, cookie: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    redirect: "manual",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, text, body, location: res.headers.get("location") ?? "" };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string } };
  return { cookie, id: me.body.id };
}

type Started = { url: string; state: string; lane?: string };
type ConnectionBody = { id: string; provider: string; kind: string };

function tokenCalls(provider: Provider): Seen[] {
  return provider.seen.filter((one) => one.path === "/token");
}

function basic(id: string, secret: string): string {
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

describe("OAuth hardening (ADR-0173)", () => {
  let ada = { cookie: "", id: "" };
  let bo = { cookie: "", id: "" };
  let ws = "";
  let adaConnection = "";
  /** The client the stand-in registered for Ada's connection, and the secret it issued with it. */
  let adaClient = { id: "", secret: "" };

  beforeAll(async () => {
    const stamp = Date.now();
    ada = await signUp("Ada", `ada-oauth-${stamp}@perch.test`);
    bo = await signUp("Bo", `bo-oauth-${stamp}@perch.test`);
    ws = (
      (await call("/api/workspaces", ada.cookie, {
        method: "POST",
        json: { name: "OAuth Nest" },
      })) as { body: { id: string } }
    ).body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, ada.cookie, {
      method: "POST",
      json: { email: `bo-oauth-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    await call(`/api/invites/${token}/accept`, bo.cookie, { method: "POST" });
  }, 60_000);

  async function start(who: { cookie: string }, json: Record<string, unknown>) {
    const res = (await call(`/api/workspaces/${ws}/connections/start`, who.cookie, {
      method: "POST",
      json,
    })) as { status: number; body: Started };
    return res;
  }

  async function mine(who: { cookie: string }, provider: string): Promise<ConnectionBody[]> {
    const list = (await call(`/api/workspaces/${ws}/connections`, who.cookie)) as {
      body: { connections: ConnectionBody[] };
    };
    return list.body.connections.filter((one) => one.provider === provider);
  }

  test("a callback in somebody else's browser attaches nothing, and spends the state", async () => {
    const started = await start(ada, { provider: "acme-mcp", lane: "mcp" });
    expect(started.status).toBe(200);
    const before = tokenCalls(home).length;

    // Ada's authorize link finishes in Bo's browser: refused, and the code is never traded.
    const hijacked = await call(
      `/api/connect/callback/acme-mcp?code=bo-code&state=${encodeURIComponent(started.body.state)}`,
      bo.cookie,
    );
    expect(hijacked.status).toBe(302);
    expect(hijacked.location).toContain("error=");
    expect(tokenCalls(home).length).toBe(before);
    expect(await mine(ada, "acme-mcp")).toEqual([]);
    expect(await mine(bo, "acme-mcp")).toEqual([]);

    // The state was spent by the refusal: Ada cannot finish on it either.
    const again = await call(
      `/api/connect/callback/acme-mcp?code=ada-code&state=${encodeURIComponent(started.body.state)}`,
      ada.cookie,
    );
    expect(again.location).toContain("error=");
    expect(await mine(ada, "acme-mcp")).toEqual([]);
  }, 60_000);

  test("a callback with no Perch session, or on another provider's path, is refused", async () => {
    const anonymous = await start(ada, { provider: "acme-mcp", lane: "mcp" });
    const signedOut = await call(
      `/api/connect/callback/acme-mcp?code=c&state=${encodeURIComponent(anonymous.body.state)}`,
      "",
    );
    expect(signedOut.location).toContain("error=");

    const crossed = await start(ada, { provider: "acme-mcp", lane: "mcp" });
    const wrongPath = await call(
      `/api/connect/callback/clerk?code=c&state=${encodeURIComponent(crossed.body.state)}`,
      ada.cookie,
    );
    expect(wrongPath.location).toContain("error=");
    expect(decodeURIComponent(wrongPath.location)).toContain("another service");
    expect(await mine(ada, "acme-mcp")).toEqual([]);
  }, 60_000);

  test("the starter finishes, and the audit actor is the starter", async () => {
    // Tokens that are already within the refresh window, so the next use refreshes.
    home.knobs.expiresIn = 30;
    const started = await start(ada, { provider: "acme-mcp", lane: "mcp" });
    expect(started.body.lane).toBe("dcr");
    const back = await call(
      `/api/connect/callback/acme-mcp?code=ada-code&state=${encodeURIComponent(started.body.state)}`,
      ada.cookie,
    );
    expect(back.location).toContain("connected=acme-mcp");
    const [row] = await mine(ada, "acme-mcp");
    adaConnection = row?.id ?? "";
    expect(row?.kind).toBe("mcp_oauth");
    const event = created.find((one) => one.payload.connectionId === adaConnection);
    expect(event?.actor).toEqual({ type: "user", id: ada.id });
    // What was stored: the server the manifest names, the resource, and where to revoke.
    const stored = await getConnection(booted.db.db, adaConnection);
    expect(stored?.metadata).toMatchObject({
      lane: "dcr",
      resource: `${home.origin}/mcp`,
      revocationEndpoint: `${home.origin}/revoke`,
    });
    expect(stored?.metadata.mcpUrl).toBeUndefined();
    const clientId = stored?.metadata.clientId ?? "";
    expect(clientId).toMatch(/^dcr-\d+$/);
    adaClient = { id: clientId, secret: clientId.replace("dcr-", "dcr-secret-") };
  }, 60_000);

  test("an MCP-lane connection refreshes with its own client, once for concurrent callers", async () => {
    const row = await getConnection(booted.db.db, adaConnection);
    if (!row) throw new Error("the connection went missing");
    const before = tokenCalls(home).filter(
      (one) => one.form?.get("grant_type") === "refresh_token",
    );
    const [one, two] = await Promise.all([
      booted.connections.tokenFor(row),
      booted.connections.tokenFor(row),
    ]);
    const refreshes = tokenCalls(home)
      .filter((call) => call.form?.get("grant_type") === "refresh_token")
      .slice(before.length);
    // One upstream refresh for both callers, and both got its token.
    expect(refreshes).toHaveLength(1);
    expect(one).toBe(two);
    expect(one).not.toBe("access-1");
    const refresh = refreshes[0];
    // The client the server registered for this connection, with its own sealed secret, and the
    // resource the token is for (RFC 8707).
    expect(refresh?.form?.get("client_id")).toBe(adaClient.id);
    expect(refresh?.authorization).toBe(basic(adaClient.id, adaClient.secret));
    expect(refresh?.form?.get("resource")).toBe(`${home.origin}/mcp`);
    expect((await getConnection(booted.db.db, adaConnection))?.status).toBe("active");
  }, 60_000);

  test("a refresh token another api process already spent is not a dead connection", async () => {
    const row = await getConnection(booted.db.db, adaConnection);
    if (!row) throw new Error("the connection went missing");
    // A second api process: same database, same vault, its own memory.
    const other = new ConnectionsService({
      db: booted.db.db,
      bus: booted.bus,
      vault: booted.vault,
      log: silentLogger(),
      publicUrl: booted.env.publicUrl,
      connectorsDir: dir,
      outbound: { allowPrivate: true },
    });
    const refreshes = () =>
      tokenCalls(home).filter((one) => one.form?.get("grant_type") === "refresh_token").length;
    const before = refreshes();
    const [one, two] = await Promise.all([booted.connections.tokenFor(row), other.tokenFor(row)]);
    // Both processes spent the same refresh token upstream: one was refused for it.
    expect(refreshes() - before).toBe(2);
    // The refused one used what the other stored, and the connection still works.
    expect(one).toBe(two);
    const after = await getConnection(booted.db.db, adaConnection);
    expect(after?.status).toBe("active");
  }, 60_000);

  test("a member's own MCP server never gets the workspace's registered app or its secret", async () => {
    const registered = await call(`/api/workspaces/${ws}/oauth-clients`, ada.cookie, {
      method: "POST",
      json: {
        provider: "acme-mcp",
        client_id: "workspace-app",
        client_secret: "workspace-app-secret",
      },
    });
    expect(registered.status).toBe(201);

    const typed = `${elsewhere.origin}/mcp`;
    const started = await start(bo, { provider: "acme-mcp", lane: "mcp", mcp_url: typed });
    expect(started.status).toBe(200);
    expect(started.body.lane).not.toBe("pre_registered");
    expect(new URL(started.body.url).searchParams.get("client_id")).not.toBe("workspace-app");
    const back = await call(
      `/api/connect/callback/acme-mcp?code=bo-code&state=${encodeURIComponent(started.body.state)}`,
      bo.cookie,
    );
    expect(back.location).toContain("connected=acme-mcp");
    for (const one of elsewhere.seen) {
      expect(one.authorization ?? "").not.toContain(btoa("workspace-app:workspace-app-secret"));
      expect(one.body).not.toContain("workspace-app");
    }
    // The typed server is the one kept, not whatever a metadata document called itself.
    const [row] = await mine(bo, "acme-mcp");
    const stored = await getConnection(booted.db.db, row?.id ?? "");
    expect(stored?.metadata.mcpUrl).toBe(typed);
    expect(stored?.metadata.lane).toBe("dcr");

    // The manifest's own server does get the workspace's app: that is what it was registered for.
    const own = await start(ada, { provider: "acme-mcp", lane: "mcp" });
    expect(own.body.lane).toBe("pre_registered");
    const ownBack = await call(
      `/api/connect/callback/acme-mcp?code=ada-code&state=${encodeURIComponent(own.body.state)}`,
      ada.cookie,
    );
    expect(ownBack.location).toContain("connected=acme-mcp");
    expect(tokenCalls(home).at(-1)?.authorization).toBe(
      basic("workspace-app", "workspace-app-secret"),
    );
  }, 60_000);

  test("discovery refuses a document for another resource, another issuer, or plain http", async () => {
    const typed = `${elsewhere.origin}/mcp`;
    elsewhere.knobs.prmResource = "https://other.example/mcp";
    const otherResource = await start(bo, { provider: "acme-mcp", lane: "mcp", mcp_url: typed });
    expect(otherResource.status).toBe(422);
    elsewhere.knobs.prmResource = undefined;

    elsewhere.knobs.issuer = "https://other.example";
    const otherIssuer = await start(bo, { provider: "acme-mcp", lane: "mcp", mcp_url: typed });
    expect(otherIssuer.status).toBe(422);
    elsewhere.knobs.issuer = undefined;

    elsewhere.knobs.tokenEndpoint = "http://tokens.example/token";
    const plainHttp = await start(bo, { provider: "acme-mcp", lane: "mcp", mcp_url: typed });
    expect(plainHttp.status).toBe(422);
    elsewhere.knobs.tokenEndpoint = undefined;
  }, 60_000);

  test("disconnecting hands the refresh token back to the provider", async () => {
    const stored = await getConnection(booted.db.db, adaConnection);
    if (!stored) throw new Error("the connection went missing");
    const before = home.seen.filter((one) => one.path === "/revoke").length;
    const gone = await call(`/api/workspaces/${ws}/connections/${adaConnection}`, ada.cookie, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    const revoked = home.seen.filter((one) => one.path === "/revoke").slice(before);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.form?.get("token")).toMatch(/^refresh-\d+$/);
    expect(revoked[0]?.form?.get("token_type_hint")).toBe("refresh_token");
    expect(revoked[0]?.authorization).toBe(basic(adaClient.id, adaClient.secret));
    expect(await getConnection(booted.db.db, adaConnection)).toBeNull();
  }, 60_000);

  test("a provider that will not take the token back does not keep the connection", async () => {
    home.knobs.revokeStatus = 503;
    const [row] = (await mine(ada, "acme-mcp")).filter((one) => one.id !== adaConnection);
    expect(row).toBeDefined();
    const gone = await call(`/api/workspaces/${ws}/connections/${row?.id}`, ada.cookie, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect(await getConnection(booted.db.db, row?.id ?? "")).toBeNull();
    home.knobs.revokeStatus = 200;
  }, 60_000);

  test("a GitHub OAuth-app connection deletes its grant when it is disconnected", async () => {
    const app = await call(`/api/workspaces/${ws}/oauth-clients`, ada.cookie, {
      method: "POST",
      json: { provider: "github", client_id: "gh-app", client_secret: "gh-secret" },
    });
    expect(app.status).toBe(201);
    const started = await start(ada, { provider: "github", lane: "oauth2" });
    expect(started.status).toBe(200);
    const back = await call(
      `/api/connect/callback/github?code=gh-code&state=${encodeURIComponent(started.body.state)}`,
      ada.cookie,
    );
    expect(back.location).toContain("connected=github");
    const [row] = await mine(ada, "github");
    const gone = await call(`/api/workspaces/${ws}/connections/${row?.id}`, ada.cookie, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    const deleted = home.seen.filter((one) => one.method === "DELETE");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.path).toBe("/applications/gh-app/grant");
    expect(deleted[0]?.authorization).toBe(basic("gh-app", "gh-secret"));
    expect(JSON.parse(deleted[0]?.body ?? "{}")).toEqual({ access_token: "gh-access" });
  }, 60_000);
});
