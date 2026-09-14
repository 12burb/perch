import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { errorResponseSchema } from "@perch/events";
import { Events, OAuth2Server } from "oauth2-mock-server";
import type { Booted } from "../src/boot.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 0.8 at the HTTP level: email + password through better-auth's routes, the users profile row,
 * /api/me and api tokens, workspace creation, invites, and the generic OIDC flow against an in-process
 * provider. The browser flows (sign up, passkey sign-in, invite accepted) are e2e/auth.spec.ts.
 */

let booted: Booted;
let oidc: OAuth2Server;
const BASE = "http://localhost:3000";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string; token?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", BASE);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return booted.app.request(`${BASE}${path}`, { ...init, headers, body });
}

async function signUp(name: string, email: string, password = "correct horse battery staple") {
  const res = await call("/api/auth/sign-up/email", {
    method: "POST",
    json: { name, email, password },
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

beforeAll(async () => {
  oidc = new OAuth2Server();
  await oidc.issuer.keys.generate("RS256");
  await oidc.start(0, "127.0.0.1");
  booted = await bootTestApp({
    PERCH_OIDC_ISSUER: oidc.issuer.url ?? "",
    PERCH_OIDC_CLIENT_ID: "perch",
    PERCH_OIDC_CLIENT_SECRET: "perch-secret",
  });
}, 60_000);

afterAll(async () => {
  await booted.close();
  await oidc.stop();
}, 30_000);

describe("auth (task 0.8)", () => {
  let dawnCookie = "";
  let dawnId = "";

  test("sign up creates the better-auth user and the Perch profile row; /api/me reads it", async () => {
    dawnCookie = await signUp("Dawn", "Dawn@Example.test");
    const me = await call("/api/me", { cookie: dawnCookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      id: string;
      email: string;
      handle: string;
      auth_kind: string;
    };
    dawnId = body.id;
    expect(body.email).toBe("dawn@example.test"); // better-auth normalizes emails
    expect(body.handle).toBe("dawn");
    expect(body.auth_kind).toBe("session");
    // A second Dawn gets a unique handle.
    const cookie2 = await signUp("Dawn Two", "dawn@other.test");
    const me2 = (await (await call("/api/me", { cookie: cookie2 })).json()) as { handle: string };
    expect(me2.handle).toBe("dawn-2");
  });

  test("unauthenticated requests get the forbidden shape; sign-in works; wrong passwords fail", async () => {
    const anon = await call("/api/me");
    expect(anon.status).toBe(403);
    const body = errorResponseSchema.parse(await anon.json());
    expect(body.error.details?.reason).toBe("unauthenticated");
    const bad = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "dawn@example.test", password: "nope-nope-nope" },
    });
    expect(bad.status).toBe(401);
    const ok = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "dawn@example.test", password: "correct horse battery staple" },
    });
    expect(ok.status).toBe(200);
    expect(cookiesFrom(ok)).toContain("better-auth.session_token");
  });

  test("PATCH /api/me validates handles and detects conflicts", async () => {
    const ok = await call("/api/me", {
      method: "PATCH",
      cookie: dawnCookie,
      json: { name: "Dawn Bird", tz: "Europe/Berlin" },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { tz: string }).tz).toBe("Europe/Berlin");
    const taken = await call("/api/me", {
      method: "PATCH",
      cookie: dawnCookie,
      json: { handle: "dawn-2" },
    });
    expect(taken.status).toBe(409);
    const invalid = await call("/api/me", {
      method: "PATCH",
      cookie: dawnCookie,
      json: { handle: "Not Valid!" },
    });
    expect(invalid.status).toBe(422);
  });

  test("api tokens: created once in plaintext, usable as Bearer, listed without the secret, revocable", async () => {
    const created = await call("/api/me/tokens", {
      method: "POST",
      cookie: dawnCookie,
      json: { name: "laptop", scopes: ["read", "write"] },
    });
    expect(created.status).toBe(201);
    const { token, id } = (await created.json()) as { token: string; id: string };
    expect(token.startsWith("pat_")).toBe(true);

    const viaToken = await call("/api/me", { token });
    expect(viaToken.status).toBe(200);
    expect(((await viaToken.json()) as { auth_kind: string; id: string }).auth_kind).toBe("token");

    const list = (await (await call("/api/me/tokens", { cookie: dawnCookie })).json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]?.token).toBeUndefined();
    expect(list.tokens[0]?.name).toBe("laptop");

    const bogus = await call("/api/me", { token: "pat_not-a-real-token" });
    expect(bogus.status).toBe(403);

    const revoked = await call(`/api/me/tokens/${id}`, { method: "DELETE", cookie: dawnCookie });
    expect(revoked.status).toBe(204);
    expect((await call("/api/me", { token })).status).toBe(403);
  });

  test("workspaces: create makes the creator owner; slugs are unique and validated", async () => {
    const created = await call("/api/workspaces", {
      method: "POST",
      cookie: dawnCookie,
      json: { name: "The Nest" },
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string; slug: string; role: string };
    expect(ws.slug).toBe("the-nest");
    expect(ws.role).toBe("owner");
    const dup = await call("/api/workspaces", {
      method: "POST",
      cookie: dawnCookie,
      json: { name: "Other", slug: "the-nest" },
    });
    expect(dup.status).toBe(409);
    const derived = await call("/api/workspaces", {
      method: "POST",
      cookie: dawnCookie,
      json: { name: "The Nest" },
    });
    expect(derived.status).toBe(201);
    expect(((await derived.json()) as { slug: string }).slug).toBe("the-nest-2");
    const list = (await (await call("/api/workspaces", { cookie: dawnCookie })).json()) as {
      workspaces: Array<{ id: string; role: string }>;
    };
    expect(list.workspaces.map((w) => w.id)).toContain(ws.id);
    expect(list.workspaces).toHaveLength(2);
  });

  test("invites: owner invites by email, preview is public, only the invited email can accept, once", async () => {
    const list = (await (await call("/api/workspaces", { cookie: dawnCookie })).json()) as {
      workspaces: Array<{ id: string; slug: string }>;
    };
    const wsId = list.workspaces.find((w) => w.slug === "the-nest")?.id ?? "";
    const invited = await call(`/api/workspaces/${wsId}/invites`, {
      method: "POST",
      cookie: dawnCookie,
      json: { email: "julius@example.test", role: "admin" },
    });
    expect(invited.status).toBe(201);
    const invite = (await invited.json()) as { accept_url: string; role: string };
    const token = invite.accept_url.split("/invite/")[1] ?? "";
    expect(token.startsWith("inv_")).toBe(true);

    const preview = await call(`/api/invites/${token}`);
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      email: string;
      status: string;
      workspace: { slug: string };
    };
    expect(previewBody.email).toBe("j*****@example.test");
    expect(previewBody.status).toBe("pending");
    expect(previewBody.workspace.slug).toBe("the-nest");

    // The wrong user cannot accept.
    const paigeCookie = await signUp("Paige", "paige@example.test");
    expect(
      (await call(`/api/invites/${token}/accept`, { method: "POST", cookie: paigeCookie })).status,
    ).toBe(403);
    // A member cannot invite.
    const juliusCookie = await signUp("Julius", "julius@example.test");
    const accepted = await call(`/api/invites/${token}/accept`, {
      method: "POST",
      cookie: juliusCookie,
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { role: string }).role).toBe("admin");
    expect(
      (await call(`/api/invites/${token}/accept`, { method: "POST", cookie: juliusCookie })).status,
    ).toBe(409);
    const asMember = await call(`/api/workspaces/${wsId}/invites`, {
      method: "POST",
      cookie: paigeCookie,
      json: { email: "kimi@example.test" },
    });
    expect(asMember.status).toBe(404);
    const juliusList = (await (await call("/api/workspaces", { cookie: juliusCookie })).json()) as {
      workspaces: Array<{ id: string; role: string }>;
    };
    expect(juliusList.workspaces).toEqual([expect.objectContaining({ id: wsId, role: "admin" })]);
    expect(dawnId).not.toBe("");
  });

  test("passkeys: registration options are issued for the instance origin", async () => {
    const res = await call("/api/auth/passkey/generate-register-options", { cookie: dawnCookie });
    expect(res.status).toBe(200);
    const options = (await res.json()) as { rp: { id: string; name: string } };
    expect(options.rp).toEqual({ id: "localhost", name: "Perch" });
  });

  test("generic OIDC (PERCH_OIDC_*): discovery → PKCE → callback → session with a profile row", async () => {
    oidc.service.once(Events.BeforeTokenSigning, (token) => {
      token.payload.sub = "oidc-user-1";
      token.payload.email = "kimi@example.test";
      token.payload.email_verified = true;
      token.payload.name = "Kimi";
    });
    oidc.service.once(Events.BeforeUserinfo, (userInfo) => {
      userInfo.body = {
        sub: "oidc-user-1",
        email: "kimi@example.test",
        email_verified: true,
        name: "Kimi",
      };
    });
    const start = await call("/api/auth/sign-in/social", {
      method: "POST",
      json: { provider: "oidc", callbackURL: "/" },
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const stateCookie = cookiesFrom(start);
    const authorize = await fetch(url, { redirect: "manual" });
    const location = new URL(authorize.headers.get("location") ?? "");
    const callback = await call(`${location.pathname}${location.search}`, { cookie: stateCookie });
    expect(callback.status).toBe(302);
    const me = await call("/api/me", { cookie: cookiesFrom(callback) });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { email: string; handle: string; name: string };
    expect(body.email).toBe("kimi@example.test");
    expect(body.handle).toBe("kimi");
    expect(body.name).toBe("Kimi");
  });
});
