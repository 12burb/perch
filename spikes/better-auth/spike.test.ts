import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { passkey } from "@better-auth/passkey";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/pglite";
import { Events, OAuth2Server } from "oauth2-mock-server";
import { authDdl, authSchema } from "./schema.ts";

/**
 * Spike 0.4.6 — better-auth on Bun (spec §9.3).
 * Pass: email + password, passkeys, and generic OIDC flows work on Bun with the Drizzle adapter on PGlite.
 * This file exercises every flow at the HTTP level (auth.handler with Request objects), including a full
 * authorization-code + PKCE round trip against an in-process OpenID provider. The browser half of passkeys
 * (a WebAuthn ceremony with a virtual authenticator) is the Playwright spec of task 0.8, which reuses this
 * configuration. Outcome recorded in DECISIONS.md (ADR-0034).
 */

const BASE = "http://localhost:3000";
let pg: PGlite;
let oidc: OAuth2Server;
let auth: ReturnType<typeof createAuth>;

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("origin", BASE);
  if (init.cookie) headers.set("cookie", init.cookie);
  return auth.handler(new Request(`${BASE}/api/auth${path}`, { ...init, headers }));
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(authDdl);
  const db = drizzle(pg, { schema: authSchema });

  oidc = new OAuth2Server();
  await oidc.issuer.keys.generate("RS256");
  await oidc.start(0, "127.0.0.1");
  const issuer = oidc.issuer.url ?? "";

  auth = createAuth(db, issuer);
}, 60_000);

function createAuth(db: ReturnType<typeof drizzle>, issuer: string) {
  return betterAuth({
    baseURL: BASE,
    secret: "spike-secret-that-is-long-enough-for-better-auth-0123456789",
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true },
    trustedOrigins: [BASE],
    plugins: [
      passkey({ rpID: "localhost", rpName: "Perch", origin: BASE }),
      genericOAuth({
        config: [
          {
            providerId: "mock-oidc",
            clientId: "perch",
            clientSecret: "perch-secret",
            discoveryUrl: `${issuer}/.well-known/openid-configuration`,
            scopes: ["openid", "profile", "email"],
            pkce: true,
          },
        ],
      }),
    ],
  });
}

afterAll(async () => {
  await oidc.stop();
  await pg.close();
}, 30_000);

describe("spike 0.4.6 better-auth on Bun (Drizzle adapter on PGlite)", () => {
  let sessionCookie = "";

  test("email + password: sign up, sign in, read the session", async () => {
    const signUp = await call("/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name: "Dawn",
        email: "dawn@example.test",
        password: "correct horse battery",
      }),
    });
    expect(signUp.status).toBe(200);
    const signIn = await call("/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "dawn@example.test", password: "correct horse battery" }),
    });
    expect(signIn.status).toBe(200);
    sessionCookie = cookiesFrom(signIn);
    expect(sessionCookie).toContain("better-auth.session_token");
    const session = await call("/get-session", { cookie: sessionCookie });
    const body = (await session.json()) as { user: { email: string } };
    expect(body.user.email).toBe("dawn@example.test");
  });

  test("email + password: a wrong password is refused", async () => {
    const res = await call("/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "dawn@example.test", password: "nope" }),
    });
    expect(res.status).toBe(401);
  });

  test("passkeys: the plugin issues WebAuthn registration options on Bun", async () => {
    const res = await call("/passkey/generate-register-options", { cookie: sessionCookie });
    expect(res.status).toBe(200);
    const options = (await res.json()) as {
      challenge: string;
      rp: { id: string; name: string };
      user: { name: string };
    };
    expect(options.challenge.length).toBeGreaterThan(16);
    expect(options.rp).toEqual({ id: "localhost", name: "Perch" });
    expect(options.user.name).toBe("dawn@example.test");
    const list = await call("/passkey/list-user-passkeys", { cookie: sessionCookie });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  test("generic OIDC: discovery → authorization code + PKCE → callback → session", async () => {
    oidc.service.once(Events.BeforeTokenSigning, (token) => {
      token.payload.sub = "oidc-user-1";
      token.payload.email = "oidc@example.test";
      token.payload.email_verified = true;
      token.payload.name = "OIDC User";
    });
    oidc.service.once(Events.BeforeUserinfo, (userInfo) => {
      userInfo.body = {
        sub: "oidc-user-1",
        email: "oidc@example.test",
        email_verified: true,
        name: "OIDC User",
      };
    });

    // better-auth 1.7 registers generic OAuth providers as social providers: the core
    // /sign-in/social and /callback/:id routes serve them.
    const start = await call("/sign-in/social", {
      method: "POST",
      body: JSON.stringify({ provider: "mock-oidc", callbackURL: "/welcome" }),
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    expect(url.startsWith(oidc.issuer.url ?? "x")).toBe(true);
    expect(url).toContain("code_challenge=");
    const stateCookie = cookiesFrom(start);

    const authorize = await fetch(url, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("location") ?? "");
    expect(location.pathname).toBe("/api/auth/callback/mock-oidc");
    expect(location.searchParams.get("code")).toBeTruthy();

    const callback = await call(`${location.pathname.replace("/api/auth", "")}${location.search}`, {
      cookie: stateCookie,
    });
    expect(callback.status).toBe(302);
    expect(["/welcome", `${BASE}/welcome`]).toContain(callback.headers.get("location") ?? "");
    const oidcCookie = cookiesFrom(callback);
    const session = await call("/get-session", { cookie: oidcCookie });
    const body = (await session.json()) as { user: { email: string; name: string } };
    expect(body.user.email).toBe("oidc@example.test");
    expect(body.user.name).toBe("OIDC User");
  });
});
