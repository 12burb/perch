import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { errorResponseSchema } from "@perch/events";
import type { Booted } from "../src/boot.ts";
import { addItem } from "../src/repos/inbox.ts";
import { bootTestApp, TEST_ADMIN } from "../src/testing.ts";

/**
 * ADR-0172 (review findings X-secu-07, A-rt-01, X-spec-06, A-rt-10): an api token's scopes and its
 * workspace binding hold on the routes that have no workspace to authorize against — the caller's
 * profile and tokens, their workspace list, their inbox, and the instance-admin pages.
 */

let booted: Booted;
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
  init: { method?: string; cookie?: string; token?: string; json?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers({ origin: BASE });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await booted.app.request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

function reason(body: unknown): unknown {
  return errorResponseSchema.parse(body).error.details?.reason;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await booted.app.request(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

async function mint(cookie: string, scopes: string[], workspaceId?: string): Promise<string> {
  const made = await call("/api/me/tokens", {
    method: "POST",
    cookie,
    json: {
      name: `t-${scopes.join("-")}`,
      scopes,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    },
  });
  expect(made.status).toBe(201);
  return (made.body as { token: string }).token;
}

let cookie = "";
let userId = "";
let wsA = "";
let wsB = "";

beforeAll(async () => {
  booted = await bootTestApp();
  const res = await booted.app.request(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Wren",
      email: "wren-gate@example.test",
      password: "correct horse battery staple",
    }),
  });
  expect(res.status).toBe(200);
  cookie = cookiesFrom(res);
  userId = ((await call("/api/me", { cookie })).body as { id: string }).id;
  const a = await call("/api/workspaces", { method: "POST", cookie, json: { name: "Gate A" } });
  const b = await call("/api/workspaces", { method: "POST", cookie, json: { name: "Gate B" } });
  wsA = (a.body as { id: string }).id;
  wsB = (b.body as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await booted.close();
});

describe("api tokens are made from a session (ADR-0045, ADR-0172)", () => {
  test("a token cannot mint another token, however wide it asks", async () => {
    const read = await mint(cookie, ["read"]);
    const before = await call("/api/me/tokens", { cookie });
    const minted = await call("/api/me/tokens", {
      method: "POST",
      token: read,
      json: { name: "wider", scopes: ["admin"] },
    });
    expect(minted.status).toBe(403);
    expect(reason(minted.body)).toBe("session_required");
    const admin = await mint(cookie, ["admin"]);
    const fromAdmin = await call("/api/me/tokens", {
      method: "POST",
      token: admin,
      json: { name: "wider", scopes: ["admin"] },
    });
    expect(fromAdmin.status).toBe(403);
    const after = await call("/api/me/tokens", { cookie });
    expect((after.body as { tokens: unknown[] }).tokens).toHaveLength(
      (before.body as { tokens: unknown[] }).tokens.length + 1,
    );
  });
});

describe("a bound, narrow token stays inside its workspace and its scopes (ADR-0162, ADR-0172)", () => {
  test("the workspace list shows only the bound workspace", async () => {
    const bound = await mint(cookie, ["read"], wsA);
    const listed = await call("/api/workspaces", { token: bound });
    expect(listed.status).toBe(200);
    expect((listed.body as { workspaces: { id: string }[] }).workspaces.map((w) => w.id)).toEqual([
      wsA,
    ]);
    const wide = await mint(cookie, ["read"]);
    const all = await call("/api/workspaces", { token: wide });
    expect((all.body as { workspaces: { id: string }[] }).workspaces.map((w) => w.id)).toEqual(
      expect.arrayContaining([wsA, wsB]),
    );
  });

  test("instance-wide and account-wide changes are refused to a bound or narrow token", async () => {
    const chat = await mint(cookie, ["chat:read"], wsA);
    const other = await mint(cookie, ["read"]);
    const otherId = (
      (await call("/api/me/tokens", { cookie })).body as { tokens: { id: string }[] }
    ).tokens[0]?.id;
    expect(otherId).toBeDefined();
    const refusals = [
      await call("/api/workspaces", { method: "POST", token: chat, json: { name: "Escape" } }),
      await call("/api/me", { method: "PATCH", token: chat, json: { name: "Renamed" } }),
      await call(`/api/me/tokens/${otherId}`, { method: "DELETE", token: chat }),
      await call("/api/me/tokens", { token: chat }),
      await call("/api/workspaces", { token: chat }),
      await call("/api/inbox", { token: chat }),
      // A wide token with only `read` may read, but not change anything account-wide.
      await call("/api/workspaces", { method: "POST", token: other, json: { name: "Escape" } }),
      await call("/api/me", { method: "PATCH", token: other, json: { name: "Renamed" } }),
    ];
    expect(refusals.map((one) => one.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    const me = await call("/api/me", { cookie });
    expect((me.body as { name: string }).name).toBe("Wren");
  });

  test("the inbox of a bound token holds its own workspace's items and nothing else", async () => {
    const inA = await addItem(booted.db.db, {
      workspaceId: wsA,
      userId,
      kind: "mention",
      refType: "message",
      refId: "gate-a",
      payload: { title: "in A" },
    });
    const inB = await addItem(booted.db.db, {
      workspaceId: wsB,
      userId,
      kind: "mention",
      refType: "message",
      refId: "gate-b",
      payload: { title: "in B" },
    });
    const bound = await mint(cookie, ["write"], wsA);
    const listed = await call("/api/inbox", { token: bound });
    expect(listed.status).toBe(200);
    const ids = (listed.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
    const resolveB = await call(`/api/inbox/${inB.id}/resolve`, { method: "POST", token: bound });
    expect(resolveB.status).toBe(404);
    const resolveA = await call(`/api/inbox/${inA.id}/resolve`, { method: "POST", token: bound });
    expect(resolveA.status).toBe(200);
  });

  test("the instance admin's pages take a session or a wide admin token, nothing narrower", async () => {
    const adminCookie = await signIn(TEST_ADMIN.email, TEST_ADMIN.password);
    const readOnly = await mint(adminCookie, ["read"]);
    const patched = await call("/api/admin/settings", {
      method: "PATCH",
      token: readOnly,
      json: { audit_retention_days: 1 },
    });
    expect(patched.status).toBe(403);
    expect(reason(patched.body)).toBe("scope");
    expect((await call("/api/admin/audit", { token: readOnly })).status).toBe(403);
    const admin = await mint(adminCookie, ["admin"]);
    expect((await call("/api/admin/settings", { token: admin })).status).toBe(200);
    expect((await call("/api/admin/settings", { cookie: adminCookie })).status).toBe(200);
    const settings = await call("/api/admin/settings", { cookie: adminCookie });
    expect((settings.body as { audit_retention_days: number }).audit_retention_days).toBe(0);
  });
});
