import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp, TEST_ADMIN } from "../src/testing.ts";
import { subscribeAsBrowser } from "./fixtures/push.ts";

/**
 * Every place a member hands the api a URL to fetch refuses one inside the api's own network
 * (ADR-0173), on an instance that has not allowed private addresses — which is team mode's
 * default. The test app runs with PERCH_OUTBOUND_ALLOW_PRIVATE=off to stand where a team instance
 * stands. Only IP literals are used, so nothing here depends on DNS or leaves the machine.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let cookie = "";
let ws = "";

beforeAll(async () => {
  booted = await bootTestApp({ PERCH_OUTBOUND_ALLOW_PRIVATE: "off" });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
  });
  expect(signIn.status).toBe(200);
  cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
  const [user] = await booted.db.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, TEST_ADMIN.email))
    .limit(1);
  const [membership] = await booted.db.db
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, user?.id ?? ""))
    .limit(1);
  ws = membership?.workspaceId ?? "";
}, 60_000);

afterAll(async () => {
  await running.stop();
});

async function post(path: string, json: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: JSON.stringify(json),
  });
  return { status: res.status, text: await res.text() };
}

const TOKEN = `ghp_${"a".repeat(36)}`;

describe("member-supplied URLs on a team instance (ADR-0173)", () => {
  test("a connection's api_base inside the api's network is refused before it is called", async () => {
    const res = await post(`/api/workspaces/${ws}/connections`, {
      kind: "token",
      provider: "github",
      token: TOKEN,
      api_base: "http://127.0.0.1:5432",
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain("api_base");
  });

  test("so is a connection's mcp_url", async () => {
    const res = await post(`/api/workspaces/${ws}/connections`, {
      kind: "token",
      provider: "github",
      token: TOKEN,
      // A public address, so the api_base check passes and the MCP one is what is refused.
      api_base: "https://93.184.216.34",
      mcp_url: "http://169.254.169.254/latest/meta-data",
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain("mcp_url");
  });

  test("and an MCP server typed into the sign-in lane is refused before discovery asks it", async () => {
    const res = await post(`/api/workspaces/${ws}/connections/start`, {
      provider: "supabase",
      lane: "mcp",
      mcp_url: "http://10.0.0.5/mcp",
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain("mcp_url");
  });

  test("a brain's base URL is refused, unless it is the operator's own Ollama", async () => {
    const refused = await post(`/api/workspaces/${ws}/credentials`, {
      provider: "openai",
      kind: "api_key",
      scope: "workspace",
      label: "Somewhere inside",
      secret: "sk-test-0000000000000000",
      base_url: "http://192.168.1.20:8000/v1",
    });
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("base_url");
    // The default Ollama address is Perch's own default, not a member's say-so.
    const ollama = await post(`/api/workspaces/${ws}/credentials`, {
      provider: "ollama",
      kind: "endpoint",
      scope: "workspace",
      label: "The instance's Ollama",
      base_url: "http://127.0.0.1:11434/v1",
    });
    expect(ollama.status).toBe(201);
  });

  test("a push endpoint must be a public https URL", async () => {
    const ua = await subscribeAsBrowser();
    for (const endpoint of [
      "http://127.0.0.1:5432/x",
      "https://127.0.0.1/x",
      "http://93.184.216.34/x",
    ]) {
      const res = await post("/api/me/push-subscriptions", { endpoint, keys: ua.subscription });
      expect(res.status).toBe(422);
      expect(res.text).toContain("endpoint");
    }
    const ok = await post("/api/me/push-subscriptions", {
      endpoint: "https://93.184.216.34/push/device-1",
      keys: ua.subscription,
    });
    expect(ok.status).toBe(201);
  });
});
