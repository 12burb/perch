import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { bootTestApp } from "../src/testing.ts";

/** Task 0.13: the setup wizard's endpoint, the sign-up gate before it, and the instance facts after. */

let booted: Booted;
const BASE = "http://localhost:3000";

async function call(path: string, init: { method?: string; json?: unknown; cookie?: string } = {}) {
  const headers = new Headers({ origin: BASE });
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return booted.app.request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

beforeAll(async () => {
  booted = await bootTestApp({}, { setup: false });
}, 60_000);

afterAll(async () => {
  await booted.close();
});

describe("setup wizard (task 0.13)", () => {
  test("before setup: the instance says so and sign-ups are refused", async () => {
    const instance = (await (await call("/api/instance")).json()) as {
      setup_complete: boolean;
      telemetry: boolean;
    };
    expect(instance.setup_complete).toBe(false);
    expect(instance.telemetry).toBe(false);
    const signUp = await call("/api/auth/sign-up/email", {
      method: "POST",
      json: { name: "Eve", email: "eve@example.test", password: "correct horse battery staple" },
    });
    expect(signUp.status).toBe(403);
    const body = (await signUp.json()) as {
      error: { code: string; details?: { reason?: string } };
    };
    expect(body.error.details?.reason).toBe("setup_required");
  });

  test("the public URL must match PERCH_PUBLIC_URL", async () => {
    const res = await call("/api/setup", {
      method: "POST",
      json: {
        admin: {
          name: "Dawn",
          email: "dawn@example.test",
          password: "correct horse battery staple",
        },
        workspace: { name: "The Nest" },
        public_url: "https://elsewhere.example.com",
        telemetry: false,
      },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details?: { configured?: string } } };
    expect(body.error.details?.configured).toBe("http://localhost:3000");
  });

  test("setup creates the admin, signs them in, creates the workspace, records telemetry, and runs once", async () => {
    const res = await call("/api/setup", {
      method: "POST",
      json: {
        admin: {
          name: "Dawn",
          email: "dawn@example.test",
          password: "correct horse battery staple",
        },
        workspace: { name: "The Nest" },
        public_url: "http://localhost:3000/",
        telemetry: true,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user_id: string; workspace_slug: string };
    expect(body.workspace_slug).toBe("the-nest");
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .join("; ");
    expect(cookie).toContain("better-auth.session_token");
    const me = (await (await call("/api/me", { cookie })).json()) as { id: string; email: string };
    expect(me.id).toBe(body.user_id);
    const workspaces = (await (await call("/api/workspaces", { cookie })).json()) as {
      workspaces: Array<{ slug: string; role: string }>;
    };
    expect(workspaces.workspaces).toEqual([
      expect.objectContaining({ slug: "the-nest", role: "owner" }),
    ]);

    const instance = (await (await call("/api/instance")).json()) as {
      setup_complete: boolean;
      telemetry: boolean;
    };
    expect(instance).toMatchObject({ setup_complete: true, telemetry: true });

    const again = await call("/api/setup", {
      method: "POST",
      json: {
        admin: { name: "Eve", email: "eve@example.test", password: "correct horse battery staple" },
        workspace: { name: "Evil" },
        public_url: "http://localhost:3000",
        telemetry: false,
      },
    });
    expect(again.status).toBe(409);

    // Sign-ups work after setup.
    const signUp = await call("/api/auth/sign-up/email", {
      method: "POST",
      json: {
        name: "Julius",
        email: "julius@example.test",
        password: "correct horse battery staple",
      },
    });
    expect(signUp.status).toBe(200);
  });
});
