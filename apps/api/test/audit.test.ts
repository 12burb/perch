import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { csvField, toCsv } from "../src/services/audit.ts";
import { bootTestApp, TEST_ADMIN } from "../src/testing.ts";

/**
 * The audit page, its export, and how long the log is kept (task 4.5).
 *
 * The acceptance is that the page answers "who did what and when" — filtered by what kind of thing
 * happened, by who did it, and by when — and that what it shows can leave as a CSV.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let cookie = "";
let ws = "";
let me = "";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((part) => part.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: { method?: string; json?: unknown; as?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: init.as ?? cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    headers: res.headers,
    body: (text && res.headers.get("content-type")?.includes("json")
      ? JSON.parse(text)
      : null) as never,
  };
}

beforeAll(async () => {
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
  });
  cookie = cookiesFrom(signIn);
  me = ((await call("/api/me")).body as { id: string }).id;
  ws = (
    (await call("/api/workspaces", { method: "POST", json: { name: "Watched" } })).body as {
      id: string;
    }
  ).id;
  // Some things to have done: a channel, a message in it, and a rename of the workspace.
  const channel = (
    (
      await call(`/api/workspaces/${ws}/channels`, {
        method: "POST",
        json: { type: "public", name: "general" },
      })
    ).body as { id: string }
  ).id;
  await call(`/api/workspaces/${ws}/channels/${channel}/messages`, {
    method: "POST",
    json: { blocks: [{ type: "text", text: "hello" }] },
  });
  await call(`/api/workspaces/${ws}`, { method: "PATCH", json: { name: "Watched closely" } });
}, 120_000);

afterAll(async () => {
  await running?.stop();
});

describe("the audit page (task 4.5)", () => {
  test("shows who did what and when, and narrows by action, actor and day", async () => {
    const all = (await call(`/api/workspaces/${ws}/audit`)) as {
      status: number;
      body: { rows: { action: string; actor_type: string; actor_id: string }[]; actions: string[] };
    };
    expect(all.status).toBe(200);
    expect(all.body.rows.length).toBeGreaterThan(2);
    // Every row says who: this workspace has only been touched by one person.
    expect([...new Set(all.body.rows.map((row) => row.actor_type))]).toEqual(["user"]);
    expect([...new Set(all.body.rows.map((row) => row.actor_id))]).toEqual([me]);
    expect(all.body.actions).toContain("channel.created");
    expect(all.body.actions).toContain("workspace.updated");

    const one = (await call(`/api/workspaces/${ws}/audit?action=channel.created`)) as {
      body: { rows: { action: string }[] };
    };
    expect(one.body.rows.map((row) => row.action)).toEqual(["channel.created"]);

    // A bot has done nothing here, so filtering by one is empty rather than everything.
    const bots = (await call(`/api/workspaces/${ws}/audit?actor_type=bot`)) as {
      body: { rows: unknown[] };
    };
    expect(bots.body.rows).toEqual([]);

    // A window that ended yesterday holds nothing that happened today.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const old = (await call(`/api/workspaces/${ws}/audit?to=${encodeURIComponent(yesterday)}`)) as {
      body: { rows: unknown[] };
    };
    expect(old.body.rows).toEqual([]);
    const since = (await call(
      `/api/workspaces/${ws}/audit?from=${encodeURIComponent(yesterday)}`,
    )) as { body: { rows: unknown[] } };
    expect(since.body.rows.length).toBeGreaterThan(2);
  }, 60_000);

  test("exports what it shows as a CSV somebody can open", async () => {
    const csv = await call(`/api/workspaces/${ws}/audit/export?action=channel.created`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment; filename=");
    const lines = csv.text.trim().split("\n");
    expect(lines[0]).toBe(
      "ts,workspace_id,actor_type,actor_id,action,target_type,target_id,ip,details",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("channel.created");
    expect(lines[1]).toContain(ws);
  }, 60_000);

  test("a member who is not an owner or an admin is refused", async () => {
    const signedUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Sam",
        email: "sam-audit@perch.test",
        password: "correct horse battery staple",
      }),
    });
    const theirs = cookiesFrom(signedUp);
    // Not a member at all: the workspace does not exist as far as they are told.
    expect((await call(`/api/workspaces/${ws}/audit`, { as: theirs })).status).toBe(404);
    expect((await call(`/api/workspaces/${ws}/audit/export`, { as: theirs })).status).toBe(404);
  }, 60_000);

  test("retention removes what is past it, and 0 keeps everything", async () => {
    const settings = await call("/api/admin/settings");
    expect(settings.status).toBe(200);
    expect((settings.body as { audit_retention_days: number }).audit_retention_days).toBe(0);
    // At 0 a prune looks and does nothing.
    expect(await booted.audit.prune()).toEqual({ days: 0, removed: 0 });

    // Age one row by two days, then keep one day.
    const [row] = await booted.db.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.workspaceId, ws))
      .limit(1);
    expect(row).toBeDefined();
    await booted.db.db
      .update(schema.auditLog)
      .set({ ts: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.auditLog.id, row?.id ?? ""));

    const patched = await call("/api/admin/settings", {
      method: "PATCH",
      json: { audit_retention_days: 1 },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { audit_retention_days: number }).audit_retention_days).toBe(1);

    const pruned = await booted.audit.prune();
    expect(pruned).toEqual({ days: 1, removed: 1 });
    const left = (await call(`/api/workspaces/${ws}/audit`)) as {
      body: { rows: { id: string }[] };
    };
    expect(left.body.rows.map((one) => one.id)).not.toContain(row?.id);

    // And it is the instance's admin who may say so, not any workspace owner.
    const signedUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        name: "Kit",
        email: "kit-audit@perch.test",
        password: "correct horse battery staple",
      }),
    });
    const theirs = cookiesFrom(signedUp);
    expect((await call("/api/admin/settings", { as: theirs })).status).toBe(403);
    expect(
      (
        await call("/api/admin/settings", {
          method: "PATCH",
          json: { audit_retention_days: 30 },
          as: theirs,
        })
      ).status,
    ).toBe(403);
    await call("/api/admin/settings", { method: "PATCH", json: { audit_retention_days: 0 } });
  }, 60_000);

  test("a CSV field cannot become a formula in somebody's spreadsheet", () => {
    expect(csvField("=cmd|' /c calc'!A1")).toBe("'=cmd|' /c calc'!A1");
    expect(csvField('a "quoted", comma')).toBe('"a ""quoted"", comma"');
    expect(csvField(null)).toBe("");
    expect(toCsv([])).toBe(
      "ts,workspace_id,actor_type,actor_id,action,target_type,target_id,ip,details\n",
    );
  });
});
