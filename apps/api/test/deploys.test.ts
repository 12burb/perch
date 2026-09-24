import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { projects } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { isReadOnlySql, readTables } from "../src/services/db-browser.ts";
import { bootTestApp } from "../src/testing.ts";
import {
  type StandInSupabase,
  type StandInVercel,
  startStandInSupabase,
  startStandInVercel,
} from "./fixtures/paas.ts";

/**
 * Task 2.15 (spec §5.5, §11): the Deploy button and the database panel.
 *
 * The acceptance §11 names is here: a deploy posts its preview URL in a thread. It is posted while
 * the build is still going — which is the point of a card that updates — and the URL arrives when
 * the provider has one, rewritten into the same message rather than said again underneath.
 *
 * The panel half is the other rule the task names: read-only by default. A SELECT reaches the
 * provider through the MCP gateway; anything that writes never leaves Perch.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let vercel: StandInVercel;
let supabase: StandInSupabase;

beforeAll(async () => {
  vercel = startStandInVercel();
  supabase = startStandInSupabase();
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  vercel.stop();
  supabase.stop();
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
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, text, body };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

type Deployment = {
  id: string;
  state: string;
  target: string;
  url: string | null;
  message_id: string;
};
type MessageRow = { id: string; blocks: { type: string; [key: string]: unknown }[] };

describe("deploys and the database panel (task 2.15)", () => {
  let cookie = "";
  let ws = "";
  let projectId = "";
  let channelId = "";
  let vercelId = "";
  let supabaseId = "";

  beforeAll(async () => {
    cookie = await signUp("Ada", `ada-deploy-${Date.now()}@perch.test`);
    const made = (await call("/api/workspaces", cookie, {
      method: "POST",
      json: { name: "Deploy Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const project = (await call(`/api/workspaces/${ws}/projects`, cookie, {
      method: "POST",
      json: { key: "nest", name: "Nest", source: "empty" },
    })) as { status: number; body: { id: string } };
    expect(project.status).toBe(201);
    projectId = project.body.id;
    // A repository is what a clone leaves behind, and the deploy route reads it off the project.
    // Writing the row is how this test gets there without a runner to clone on.
    await booted.db.db
      .update(projects)
      .set({ repoUrl: "https://github.com/perch/nest.git" })
      .where(eq(projects.id, projectId));
    const channel = (await call(`/api/workspaces/${ws}/channels`, cookie, {
      method: "POST",
      json: { type: "public", name: "deploys" },
    })) as { body: { id: string } };
    channelId = channel.body.id;

    // Two connections, both on pasted tokens, both pointed at the stand-ins the way a self-hosted
    // install would be pointed at its own host.
    const one = (await call(`/api/workspaces/${ws}/connections`, cookie, {
      method: "POST",
      json: {
        kind: "token",
        provider: "vercel",
        token: vercel.token,
        owner_type: "workspace",
        api_base: vercel.url,
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(one.status).toBe(201);
    vercelId = one.body.id;
    const two = (await call(`/api/workspaces/${ws}/connections`, cookie, {
      method: "POST",
      json: {
        kind: "token",
        provider: "supabase",
        token: supabase.token,
        owner_type: "workspace",
        api_base: supabase.url,
        mcp_url: supabase.mcpUrl,
      },
    })) as { status: number; text: string; body: { id: string } };
    expect(two.status).toBe(201);
    supabaseId = two.body.id;
  }, 60_000);

  test("a deploy posts its preview URL in a thread", async () => {
    const started = (await call(`/api/workspaces/${ws}/projects/${projectId}/deploys`, cookie, {
      method: "POST",
      json: { connection_id: vercelId, channel_id: channelId, target: "preview" },
    })) as { status: number; body: Deployment };
    expect(started.status).toBe(201);
    // The build has not finished, so the card says so rather than inventing a URL.
    expect(started.body.state).toBe("building");
    expect(started.body.url).toBeNull();

    // What the provider was asked for: this project's repository, at its branch, as a preview.
    expect(vercel.created).toHaveLength(1);
    expect(vercel.created[0]).toMatchObject({
      name: "nest",
      target: "preview",
      org: "perch",
      repo: "nest",
      ref: "main",
    });

    // The card is in the channel, and it is the deploy's record.
    const posted = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, cookie)) as {
      body: { messages: MessageRow[] };
    };
    const card = posted.body.messages
      .flatMap((row) => row.blocks)
      .find((block) => block.type === "deploy_card");
    expect(card).toMatchObject({
      provider: "vercel",
      deploymentId: started.body.id,
      target: "preview",
      state: "building",
      branch: "main",
    });

    // The build finishes, and asking again rewrites the same message rather than posting another.
    vercel.finish(started.body.id, "nest-abc123.vercel.app");
    const fresh = (await call(
      `/api/workspaces/${ws}/projects/${projectId}/deploys/refresh`,
      cookie,
      {
        method: "POST",
        json: { connection_id: vercelId, message_id: started.body.message_id },
      },
    )) as { status: number; body: Deployment };
    expect(fresh.status).toBe(200);
    expect(fresh.body.state).toBe("ready");
    expect(fresh.body.url).toBe("https://nest-abc123.vercel.app");

    const after = (await call(`/api/workspaces/${ws}/channels/${channelId}/messages`, cookie)) as {
      body: { messages: MessageRow[] };
    };
    const cards = after.body.messages
      .flatMap((row) => row.blocks)
      .filter((block) => block.type === "deploy_card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      state: "ready",
      url: "https://nest-abc123.vercel.app",
    });

    // The connection's token went to the provider and nowhere else.
    expect(vercel.seen.every((one) => one.auth === `Bearer ${vercel.token}`)).toBe(true);
    expect(JSON.stringify(after.body)).not.toContain(vercel.token);
  }, 60_000);

  test("a card goes into a channel the caller can see, and nowhere else", async () => {
    // Bea joins and makes a private room of her own; Ada, who owns the workspace, is not in it.
    const stamp = Date.now();
    const bea = await signUp("Bea", `bea-deploy-${stamp}@perch.test`);
    const invite = (await call(`/api/workspaces/${ws}/invites`, cookie, {
      method: "POST",
      json: { email: `bea-deploy-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const accept = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect((await call(`/api/invites/${accept}/accept`, bea, { method: "POST" })).status).toBe(200);
    const room = (await call(`/api/workspaces/${ws}/channels`, bea, {
      method: "POST",
      json: { type: "private", name: "beas-room" },
    })) as { status: number; body: { id: string } };
    expect(room.status).toBe(201);

    const posted = await call(`/api/workspaces/${ws}/projects/${projectId}/deploys`, cookie, {
      method: "POST",
      json: { connection_id: vercelId, channel_id: room.body.id, target: "preview" },
    });
    expect(posted.status).toBe(404);
    const inside = (await call(`/api/workspaces/${ws}/channels/${room.body.id}/messages`, bea)) as {
      body: { messages: MessageRow[] };
    };
    expect(
      inside.body.messages.flatMap((row) => row.blocks).some((b) => b.type === "deploy_card"),
    ).toBe(false);
  }, 60_000);

  test("a card threads only under a message in its own channel", async () => {
    // Code review (ADR-0176): a thread root from another channel would file the card under a
    // conversation somewhere else, which the bot runtime would then read as this thread.
    const other = (await call(`/api/workspaces/${ws}/channels`, cookie, {
      method: "POST",
      json: { type: "public", name: "elsewhere" },
    })) as { status: number; body: { id: string } };
    expect(other.status).toBe(201);
    const said = (await call(`/api/workspaces/${ws}/channels/${other.body.id}/messages`, cookie, {
      method: "POST",
      json: { text: "a thread over here" },
    })) as { status: number; body: { id: string } };
    expect(said.status).toBe(201);
    const before = vercel.created.length;
    const posted = await call(`/api/workspaces/${ws}/projects/${projectId}/deploys`, cookie, {
      method: "POST",
      json: {
        connection_id: vercelId,
        channel_id: channelId,
        target: "preview",
        thread_root_id: said.body.id,
      },
    });
    expect(posted.status).toBe(404);
    // Refused before anything was asked of the provider.
    expect(vercel.created.length).toBe(before);
  }, 60_000);

  test("the database panel reads, and refuses anything that writes", async () => {
    const tables = (await call(
      `/api/workspaces/${ws}/connections/${supabaseId}/db/tables`,
      cookie,
    )) as { status: number; body: { tables: { name: string; columns: { name: string }[] }[] } };
    expect(tables.status).toBe(200);
    expect(tables.body.tables).toHaveLength(1);
    expect(tables.body.tables[0]).toMatchObject({ schema: "public", name: "birds", rows: 3 });
    expect(tables.body.tables[0]?.columns.map((one) => one.name)).toEqual(["id", "name"]);
    // The manifest's default schema went out, through the gateway, as the tool's own argument.
    expect(supabase.called.at(-1)).toMatchObject({
      tool: "list_tables",
      args: { schemas: ["public"] },
    });

    const read = (await call(`/api/workspaces/${ws}/connections/${supabaseId}/db/query`, cookie, {
      method: "POST",
      json: { sql: "select id, name from birds limit 1" },
    })) as { status: number; body: { columns: string[]; rows: Record<string, unknown>[] } };
    expect(read.status).toBe(200);
    expect(read.body.columns).toEqual(["id", "name"]);
    expect(read.body.rows).toEqual([{ id: "1", name: "swift" }]);

    const asked = supabase.called.length;
    const write = (await call(`/api/workspaces/${ws}/connections/${supabaseId}/db/query`, cookie, {
      method: "POST",
      json: { sql: "delete from birds" },
    })) as { status: number; body: { error?: { code?: string; message?: string } } };
    expect(write.status).toBe(451);
    expect(write.body.error?.message).toContain("permission prompt");
    // Refused before the provider was touched: the count did not move.
    expect(supabase.called.length).toBe(asked);
  }, 60_000);

  test("a statement is a read only when every part of it is", () => {
    expect(isReadOnlySql("select 1")).toBe(true);
    expect(isReadOnlySql("  WITH x AS (select 1) select * from x  ")).toBe(true);
    expect(isReadOnlySql("explain analyse select 1")).toBe(false);
    expect(isReadOnlySql("select 1; delete from birds")).toBe(false);
    // A write inside a comment is not a write — and a write behind one is still a write.
    expect(isReadOnlySql("select 1 -- ; delete from birds")).toBe(true);
    expect(isReadOnlySql("/* select */ delete from birds")).toBe(false);
    expect(
      isReadOnlySql("with x as (insert into birds values (1) returning *) select * from x"),
    ).toBe(false);
    expect(isReadOnlySql("")).toBe(false);
  });

  test("tables come back whichever shape the server listed them in", () => {
    expect(
      readTables({
        tables: [{ table_schema: "auth", table_name: "users", row_count: 2, columns: [] }],
      }),
    ).toEqual([{ schema: "auth", name: "users", rows: 2, columns: [] }]);
    expect(readTables(null)).toEqual([]);
  });
});
