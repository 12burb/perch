import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@perch/db";
import { count, eq, sql } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { parseQuery } from "../src/services/search.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 2.4 (spec §5.2 "Postgres full-text over messages and files with filters", §7.1): finding
 * something that was said. What matches, what a filter narrows it to, what a private channel keeps
 * to itself — and the acceptance: a search of 100,000 messages answers in under 150 ms.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let filesDir = "";
let ws = "";
let general = "";
let founders = "";
let wren = { cookie: "", id: "", handle: "" };
let robin = { cookie: "", id: "", handle: "" };

beforeAll(async () => {
  filesDir = mkdtempSync(join(tmpdir(), "perch-search-"));
  booted = await bootTestApp({ PERCH_FILES_DIR: filesDir });
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
}, 60_000);

afterAll(async () => {
  await running.stop();
  rmSync(filesDir, { recursive: true, force: true });
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
  return { status: res.status, body: (text ? JSON.parse(text) : null) as unknown };
}

async function signUp(name: string, email: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name, email, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await call("/api/me", cookie)) as { body: { id: string; handle: string } };
  return { cookie, id: me.body.id, handle: me.body.handle };
}

type Hit = {
  id: string;
  channel_id: string;
  channel_name: string | null;
  author_name: string | null;
  blocks: { type: string; text?: string }[];
  rank: number;
};
type FileHit = { file: { id: string; name: string }; channel_name: string | null };
type Results = { status: number; body: { messages: Hit[]; files: FileHit[] } };

const find = (cookie: string, query: string) =>
  call(`/api/workspaces/${ws}/search?${query}`, cookie) as Promise<Results>;

const say = (cookie: string, channel: string, text: string) =>
  call(`/api/workspaces/${ws}/channels/${channel}/messages`, cookie, {
    method: "POST",
    json: { text },
  }) as Promise<{ status: number; body: { id: string } }>;

describe("search (task 2.4)", () => {
  test("a query has to be a query", () => {
    expect(parseQuery("  ships  ")).toBe("ships");
    expect(() => parseQuery(" a ")).toThrow();
    expect(() => parseQuery("x".repeat(201))).toThrow();
  });

  test("what was said comes back, ranked, with where and who", async () => {
    const stamp = Date.now();
    wren = await signUp("Wren", `wren-search-${stamp}@perch.test`);
    robin = await signUp("Robin", `robin-search-${stamp}@perch.test`);
    const made = (await call("/api/workspaces", wren.cookie, {
      method: "POST",
      json: { name: "Search Nest" },
    })) as { body: { id: string } };
    ws = made.body.id;
    const invite = (await call(`/api/workspaces/${ws}/invites`, wren.cookie, {
      method: "POST",
      json: { email: `robin-search-${stamp}@perch.test`, role: "member" },
    })) as { body: { accept_url: string } };
    const token = invite.body.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, robin.cookie, { method: "POST" })).status,
    ).toBe(200);

    const open = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "public", name: "general" },
    })) as { body: { id: string } };
    general = open.body.id;
    const shut = (await call(`/api/workspaces/${ws}/channels`, wren.cookie, {
      method: "POST",
      json: { type: "private", name: "founders" },
    })) as { body: { id: string } };
    founders = shut.body.id;
    await call(`/api/workspaces/${ws}/channels/${general}/members`, robin.cookie, {
      method: "POST",
      json: {},
    });

    await say(wren.cookie, general, "the migration ran cleanly on staging");
    await say(robin.cookie, general, "migrations are the scary part of any deploy");
    await say(wren.cookie, general, "lunch?");
    await say(wren.cookie, founders, "the migration of the payroll numbers is done");

    const hits = await find(wren.cookie, "q=migration");
    expect(hits.status).toBe(200);
    // English stemming: "migration" finds "migrations" too.
    expect(hits.body.messages).toHaveLength(3);
    expect(hits.body.messages.every((hit) => hit.rank > 0)).toBe(true);
    const first = hits.body.messages[0];
    expect(first?.channel_name).not.toBeNull();
    expect(first?.author_name).not.toBeNull();
    expect(hits.body.messages.some((hit) => hit.blocks[0]?.text?.includes("lunch"))).toBe(false);
  }, 60_000);

  test("a private channel keeps its own, and the filters narrow what is left", async () => {
    // Robin is not in #founders, so the payroll message is not theirs to find.
    const asRobin = await find(robin.cookie, "q=migration");
    expect(asRobin.body.messages).toHaveLength(2);
    expect(asRobin.body.messages.some((hit) => hit.channel_id === founders)).toBe(false);

    // …and naming that channel is refused the way the channel itself is (404, not an empty list).
    const named = await find(robin.cookie, `q=migration&channel=${founders}`);
    expect(named.status).toBe(404);

    // From one person, in one channel.
    const mine = await find(wren.cookie, `q=migration&from=${wren.id}&channel=${general}`);
    expect(mine.body.messages).toHaveLength(1);
    expect(mine.body.messages[0]?.blocks[0]?.text).toContain("staging");

    // A phrase in quotes is the phrase, not the words.
    const phrase = await find(wren.cookie, `q=${encodeURIComponent('"scary part"')}`);
    expect(phrase.body.messages).toHaveLength(1);
    // And a word can be taken out of the question.
    const without = await find(wren.cookie, `q=${encodeURIComponent("migration -payroll")}`);
    expect(without.body.messages).toHaveLength(2);
  }, 60_000);

  test("files are found by name, and only where they could have been seen", async () => {
    const upload = async (cookie: string, name: string) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array([1, 2, 3])], name, { type: "text/plain" }));
      const res = await fetch(`${base}/api/workspaces/${ws}/files`, {
        method: "POST",
        headers: { cookie, origin: base },
        body: form,
      });
      return (await res.json()) as { id: string };
    };
    const shared = await upload(wren.cookie, "deploy-notes.txt");
    const secret = await upload(wren.cookie, "deploy-payroll.txt");
    await call(`/api/workspaces/${ws}/channels/${general}/messages`, wren.cookie, {
      method: "POST",
      json: { blocks: [{ type: "file", fileId: shared.id }] },
    });
    await call(`/api/workspaces/${ws}/channels/${founders}/messages`, wren.cookie, {
      method: "POST",
      json: { blocks: [{ type: "file", fileId: secret.id }] },
    });

    const asWren = await find(wren.cookie, "q=deploy&type=files");
    expect(asWren.body.files.map((hit) => hit.file.name).sort()).toEqual([
      "deploy-notes.txt",
      "deploy-payroll.txt",
    ]);
    expect(asWren.body.messages).toEqual([]);

    // Robin can see the one said in #general and not the one said in #founders…
    const asRobin = await find(robin.cookie, "q=deploy&type=files");
    expect(asRobin.body.files.map((hit) => hit.file.name)).toEqual(["deploy-notes.txt"]);
    expect(asRobin.body.files[0]?.channel_name).toBe("general");

    // …and cannot read its bytes either, which is what ADR-0093 left open (ADR-0094).
    const refused = await fetch(`${base}/api/files/${secret.id}`, {
      headers: { cookie: robin.cookie },
    });
    expect(refused.status).toBe(404);
    const allowed = await fetch(`${base}/api/files/${shared.id}`, {
      headers: { cookie: robin.cookie },
    });
    expect(allowed.status).toBe(200);
  }, 60_000);

  test("acceptance: 100,000 messages, answered in under 150 ms", async () => {
    // Seeded in the database rather than through the api: this is about the query, not the routes.
    // `gen_random_uuid()` is fine for rows nobody pages through.
    const db = booted.db.db;
    await db.execute(sql`
      insert into messages (id, workspace_id, channel_id, author_type, author_id, blocks)
      select
        gen_random_uuid(),
        ${ws}::uuid,
        ${general}::uuid,
        'user',
        ${wren.id}::uuid,
        jsonb_build_array(jsonb_build_object(
          'type', 'text',
          'text', 'note ' || g || ' about ' || (array['rigging','plumage','sextant'])[1 + g % 3]
        ))
      from generate_series(1, 100000) g
    `);
    const [counted] = await db
      .select({ total: count() })
      .from(schema.messages)
      .where(eq(schema.messages.channelId, general));
    expect(Number(counted?.total ?? 0)).toBeGreaterThanOrEqual(100_000);

    // A cold first query, then the one that is timed: an index scan, not a warm cache trick.
    await find(wren.cookie, "q=sextant&limit=30");
    const runs: number[] = [];
    for (const word of ["sextant", "plumage", "rigging"]) {
      const started = Bun.nanoseconds();
      const hits = await find(wren.cookie, `q=${word}&type=messages&limit=30`);
      runs.push((Bun.nanoseconds() - started) / 1_000_000);
      expect(hits.body.messages).toHaveLength(30);
    }
    const slowest = Math.max(...runs);
    console.log(`search over 100k messages: ${runs.map((ms) => ms.toFixed(0)).join("/")} ms`);
    expect(slowest).toBeLessThan(150);
  }, 300_000);
});
