import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { getConnection } from "../src/repos/connections.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.14 (spec §3.5): the MCP OAuth lanes. The acceptance is here twice — an MCP server that
 * registers clients on the spot is connected without anything being registered beforehand (the
 * lane Supabase's MCP server uses), and a bot the whole workspace can talk to is refused somebody's
 * personal connection.
 *
 * The provider is a stand-in on this machine, reached the way a self-hosted one would be: through
 * `mcp_url`, the same kind of override `api_base` is for. No test-only seam inside Perch.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let provider: ReturnType<typeof Bun.serve> | null = null;
let providerUrl = "";
/** What the stand-in was asked, so the test can prove which lane was taken. */
const seen: string[] = [];
let issued = 0;
/** Turned on for the CIMD case: a server that takes a client metadata document says so. */
let cimd = false;

beforeAll(async () => {
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}`);
      const origin = `http://127.0.0.1:${provider?.port ?? 0}`;
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["projects:read"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(cimd
            ? { client_id_metadata_document_supported: true }
            : { registration_endpoint: `${origin}/register` }),
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        // RFC 7591: what Perch says about itself, without claiming a client_id.
        expect(body.client_id).toBeUndefined();
        expect(String(body.client_name)).toBe("Perch");
        issued += 1;
        return Response.json({ client_id: `dcr-${issued}`, client_secret: "registered-secret" });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        // RFC 8707: the token is asked for one resource, and PKCE proves who is asking.
        expect(form.get("resource")).toBe(`${origin}/mcp`);
        expect(form.get("code_verifier")).toBeTruthy();
        expect(form.get("grant_type")).toBe("authorization_code");
        return Response.json({
          access_token: "mcp-access-token",
          refresh_token: "mcp-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "projects:read",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  providerUrl = `http://127.0.0.1:${provider.port}`;
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  provider?.stop(true);
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
    headers: { cookie, "content-type": "application/json", origin: base },
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
  return { status: res.status, text, body, headers: res.headers };
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
type ConnectionBody = { id: string; provider: string; kind: string; owner_type: string };

describe("connections v2 (task 2.14)", () => {
  let ada = { cookie: "", id: "" };
  let bo = { cookie: "", id: "" };
  let ws = "";
  let connectionId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    ada = await signUp("Ada", `ada-mcp-${stamp}@perch.test`);
    bo = await signUp("Bo", `bo-mcp-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", ada.cookie, {
      method: "POST",
      json: { name: "Connect Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, ada.cookie, {
      method: "POST",
      json: { email: `bo-mcp-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    await call(`/api/invites/${token}/accept`, bo.cookie, { method: "POST" });
  }, 60_000);

  test("the three connectors this task adds are offered", async () => {
    const res = (await call(`/api/workspaces/${ws}/connection-providers`, ada.cookie)) as {
      body: { providers: { id: string; lanes: string[]; mcp_url?: string }[] };
    };
    const ids = res.body.providers.map((one) => one.id);
    expect(ids).toContain("vercel");
    expect(ids).toContain("supabase");
    expect(ids).toContain("clerk");
    const supabase = res.body.providers.find((one) => one.id === "supabase");
    expect(supabase?.lanes).toContain("mcp_oauth");
    // The paste lane is always there, whatever else a manifest says.
    expect(supabase?.lanes).toContain("token");
  }, 30_000);

  test("an MCP server that registers clients on the spot is connected without one", async () => {
    seen.length = 0;
    const started = (await call(`/api/workspaces/${ws}/connections/start`, ada.cookie, {
      method: "POST",
      json: { provider: "supabase", lane: "mcp", mcp_url: `${providerUrl}/mcp` },
    })) as { status: number; body: Started };
    expect(started.status).toBe(200);
    expect(started.body.lane).toBe("dcr");

    // Discovery went RFC 9728 → RFC 8414 → registration, in that order.
    expect(seen).toEqual([
      "GET /.well-known/oauth-protected-resource/mcp",
      "GET /.well-known/oauth-authorization-server",
      "POST /register",
    ]);

    // The authorize URL is the server's own, with PKCE and the resource the token is for.
    const url = new URL(started.body.url);
    expect(url.origin + url.pathname).toBe(`${providerUrl}/authorize`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("dcr-1");
    expect(url.searchParams.get("resource")).toBe(`${providerUrl}/mcp`);

    // The provider sends the person back, and the code becomes a connection.
    const back = await call(
      `/api/connect/callback/supabase?code=the-code&state=${encodeURIComponent(started.body.state)}`,
      ada.cookie,
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toContain("connected=supabase");

    const list = (await call(`/api/workspaces/${ws}/connections`, ada.cookie)) as {
      text: string;
      body: { connections: ConnectionBody[] };
    };
    const row = list.body.connections.find((one) => one.provider === "supabase");
    expect(row).toMatchObject({ kind: "mcp_oauth", owner_type: "user" });
    connectionId = row?.id ?? "";
    // The token it traded for is not in any answer, here or anywhere.
    expect(list.text).not.toContain("mcp-access-token");
    expect(list.text).not.toContain("registered-secret");
    // What goes upstream as the bearer is the access token alone — never the stored pair with
    // the refresh token in it (AGENTS.md §1.6).
    const stored = await getConnection(booted.db.db, connectionId);
    expect(stored).not.toBeNull();
    if (stored) expect(await booted.connections.tokenFor(stored)).toBe("mcp-access-token");

    // A replayed callback finds nothing: the state was single-use.
    const again = await call(
      `/api/connect/callback/supabase?code=the-code&state=${encodeURIComponent(started.body.state)}`,
      ada.cookie,
    );
    expect(again.headers.get("location")).toContain("error=");
  }, 60_000);

  test("a server that takes a client metadata document is not registered with at all", async () => {
    cimd = true;
    seen.length = 0;
    const started = (await call(`/api/workspaces/${ws}/connections/start`, ada.cookie, {
      method: "POST",
      json: { provider: "clerk", lane: "mcp", mcp_url: `${providerUrl}/mcp` },
    })) as { body: Started };
    expect(started.body.lane).toBe("cimd");
    expect(seen).not.toContain("POST /register");
    // The client id is this instance's own document, which is a URL a provider can fetch.
    const url = new URL(started.body.url);
    expect(url.searchParams.get("client_id")).toContain("/.well-known/oauth-client-metadata.json");
    cimd = false;
  }, 30_000);

  test("a shared bot is refused a personal connection", async () => {
    const shared = (await call(`/api/workspaces/${ws}/bots`, ada.cookie, {
      method: "POST",
      json: { handle: "everyone", name: "Everyone's bot", visibility: "workspace" },
    })) as { status: number; body: { id: string } };
    expect(shared.status).toBe(201);
    const mine = (await call(`/api/workspaces/${ws}/bots`, ada.cookie, {
      method: "POST",
      json: { handle: "mine", name: "Ada's bot", visibility: "private" },
    })) as { body: { id: string } };

    // Ada's connection is Ada's: a bot the workspace can talk to may not simply be handed it.
    const refused = await call(
      `/api/workspaces/${ws}/connections/${connectionId}/grants`,
      ada.cookie,
      {
        method: "POST",
        json: { subject_type: "bot", subject_id: shared.body.id, obo: false },
      },
    );
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("on their behalf");

    // On her behalf, it may — and the grant says so.
    const granted = (await call(
      `/api/workspaces/${ws}/connections/${connectionId}/grants`,
      ada.cookie,
      { method: "POST", json: { subject_type: "bot", subject_id: shared.body.id, obo: true } },
    )) as { status: number; body: { id: string; obo: boolean } };
    expect(granted.status).toBe(201);
    expect(granted.body.obo).toBe(true);

    // And the rule holds where it is used, not only where it was given.
    const connection = await booted.connections.connectionFor(ws, ada.id, connectionId);
    if (!connection) throw new Error("the connection went missing");
    expect(
      await booted.connections.mayUse({
        connection,
        subjectType: "bot",
        subjectId: shared.body.id,
        invokedBy: ada.id,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await booted.connections.mayUse({
        connection,
        subjectType: "bot",
        subjectId: shared.body.id,
        invokedBy: bo.id,
      }),
    ).toMatchObject({ ok: false });
    // A bot nobody granted anything is refused whoever asks.
    expect(
      await booted.connections.mayUse({
        connection,
        subjectType: "bot",
        subjectId: mine.body.id,
        invokedBy: ada.id,
      }),
    ).toMatchObject({ ok: false });

    // The grants are listed, and taking one away works.
    const grants = (await call(
      `/api/workspaces/${ws}/connections/${connectionId}/grants`,
      ada.cookie,
    )) as { body: { grants: { id: string }[] } };
    expect(grants.body.grants).toHaveLength(1);
    const gone = await call(
      `/api/workspaces/${ws}/connections/${connectionId}/grants/${granted.body.id}`,
      ada.cookie,
      { method: "DELETE" },
    );
    expect(gone.status).toBe(204);
  }, 60_000);
});
