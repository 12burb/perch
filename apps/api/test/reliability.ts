#!/usr/bin/env bun
/**
 * The reliability bar (task 4.10; spec §10's Phase 4 line "load, upgrade and chaos tests with
 * published targets").
 *
 * Three drills, each with a number written down rather than a feeling:
 *
 *   load     a hundred sessions open at once on one instance, and every one of them answers
 *   upgrade  a database at an older schema migrates forward with every row still in it, and a
 *            backup written by an older Perch restores into a newer one
 *   chaos    a runner killed mid-turn leaves nothing running, and the workspace takes a new one
 *
 * The targets are in `TARGETS` and printed with every run, so a regression is a number that moved
 * and not an argument. `bun run reliability` runs all three; `--only load` runs one; `--sessions`
 * changes the load drill's size (the test runs a smaller bar so `bun run check` stays quick).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb, dumpDatabase, embeddedMigrations, migrateTo, restoreDatabase } from "@perch/db";
import { FakeEngine } from "@perch/engines";
import { createInProcessRunner } from "@perch/runner";
import { sql } from "drizzle-orm";
import { serve } from "../src/server.ts";
import { bootTestApp, TEST_ADMIN } from "../src/testing.ts";

/** What Perch promises, and what a run is measured against. */
export const TARGETS = {
  /** Sessions open at once on one instance, all of them answering. */
  sessions: 100,
  /**
   * The slowest 5% of opens *once the instance is already holding them all*, in milliseconds. It is
   * measured one at a time after the wave, not inside it: a hundred opens fired in the same
   * millisecond queue behind each other by definition, and the number that tells anybody anything
   * is how Perch feels to the next person through the door.
   */
  openP95Ms: 3_000,
  /** The whole wave — every session opened and every turn settled — in milliseconds. */
  waveMs: 60_000,
  /** The slowest 5% of rounds, from the turn to the session leaving `running`. */
  settleP95Ms: 30_000,
  /** How much the instance may grow while it holds them, in MB. */
  rssGrowthMb: 768,
  /** How long after a runner dies a session may still say it is running, in milliseconds. */
  recoverMs: 20_000,
} as const;

export type Row = {
  name: string;
  ok: boolean;
  measured: string;
  target: string;
};

export function ms(value: number): string {
  return `${Math.round(value)} ms`;
}

/** The p-th percentile of a sample, nearest-rank: with 20 values, p95 is the 19th. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

type Client = {
  base: string;
  cookie: string;
  call(
    path: string,
    init?: { method?: string; json?: unknown },
  ): Promise<{ status: number; text: string; body: unknown }>;
};

/**
 * A fresh account with a workspace of its own, made the way anybody's is. The `origin` is the
 * instance's public URL rather than the address the drill happens to reach it on: that is what a
 * browser would send, and what the auth layer trusts.
 */
async function signedIn(base: string, origin: string): Promise<Client> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      name: "Drill",
      email: `drill-${crypto.randomUUID()}@perch.test`,
      password: TEST_ADMIN.password,
    }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
  const call: Client["call"] = async (path, init = {}) => {
    const answer = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { cookie, "content-type": "application/json", origin },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    const text = await answer.text();
    return { status: answer.status, text, body: (text ? JSON.parse(text) : null) as unknown };
  };
  const made = await call("/api/workspaces", { method: "POST", json: { name: "Drill Nest" } });
  if (made.status !== 201) throw new Error(`workspace: ${made.status} ${made.text.slice(0, 200)}`);
  return { base, cookie, call };
}

async function readyProject(client: Client, ws: string, name: string): Promise<string> {
  const created = (await client.call(`/api/workspaces/${ws}/projects`, {
    method: "POST",
    json: { name },
  })) as { status: number; body: { id: string } };
  if (created.status !== 201) throw new Error(`project: ${created.status}`);
  const id = created.body.id;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const row = (await client.call(`/api/workspaces/${ws}/projects/${id}`)) as {
      body: { status: string; status_message: string | null };
    };
    if (row.body.status === "ready") return id;
    if (row.body.status === "error") throw new Error(`project failed: ${row.body.status_message}`);
    if (Date.now() > deadline) throw new Error(`project stayed ${row.body.status}`);
    await Bun.sleep(100);
  }
}

async function firstWorkspace(client: Client): Promise<string> {
  const mine = (await client.call("/api/workspaces")) as { body: { workspaces: { id: string }[] } };
  const ws = mine.body.workspaces[0]?.id;
  if (!ws) throw new Error("the admin is in no workspace");
  return ws;
}

/**
 * A hundred sessions at once. The engine is in-process on purpose: what this measures is Perch
 * under concurrency — the api, the database, the bus, the session service and the WS fan-out — and
 * not how fast somebody else's CLI starts.
 */
export async function loadDrill(options: { sessions?: number } = {}): Promise<Row[]> {
  const count = options.sessions ?? TARGETS.sessions;
  const fake = new FakeEngine({ id: "fake" });
  const booted = await bootTestApp({}, { engines: [fake], sessions: { silenceMs: 120_000 } });
  const projectsDir = mkdtempSync(join(tmpdir(), "perch-load-"));
  booted.runners.attach(createInProcessRunner({ projectsDir, portsIntervalMs: 0 }));
  const running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  const before = process.memoryUsage().rss;
  try {
    const client = await signedIn(running.url, booted.env.publicUrl);
    const ws = await firstWorkspace(client);
    const project = await readyProject(client, ws, "Load");

    const opens: number[] = [];
    const settles: number[] = [];
    const failures: string[] = [];
    const started = performance.now();
    await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const openedAt = performance.now();
        const created = (await client.call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
          method: "POST",
          json: { engine: "fake", prompt: `turn ${i}` },
        })) as { status: number; text: string; body: { id: string } };
        if (created.status !== 201) {
          failures.push(`open ${i}: ${created.status} ${created.text.slice(0, 120)}`);
          return;
        }
        opens.push(performance.now() - openedAt);
        const deadline = Date.now() + 120_000;
        for (;;) {
          const row = (await client.call(`/api/sessions/${created.body.id}`)) as {
            body: { status: string };
          };
          if (row.body.status !== "running") {
            if (row.body.status === "error") failures.push(`session ${i}: error`);
            settles.push(performance.now() - openedAt);
            return;
          }
          if (Date.now() > deadline) {
            failures.push(`session ${i}: still running`);
            return;
          }
          await Bun.sleep(50);
        }
      }),
    );
    const wall = performance.now() - started;

    // The instance is now holding `count` sessions. What does the next person through the door
    // feel? Ten more opens, one at a time, on the instance in that state.
    const after: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const at = performance.now();
      const one = (await client.call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
        method: "POST",
        json: { engine: "fake", title: `steady ${i}` },
      })) as { status: number; text: string };
      if (one.status !== 201) {
        failures.push(`steady open ${i}: ${one.status} ${one.text.slice(0, 120)}`);
        break;
      }
      after.push(performance.now() - at);
    }

    const grown = (process.memoryUsage().rss - before) / (1024 * 1024);
    const openP95 = percentile(after, 95);
    const settleP95 = percentile(settles, 95);
    return [
      {
        name: "sessions that opened and answered",
        ok: failures.length === 0 && settles.length === count,
        measured: `${settles.length}/${count}${failures.length ? ` — ${failures[0]}` : ""}`,
        target: `${count}`,
      },
      {
        name: "the whole wave",
        ok: wall <= TARGETS.waveMs,
        measured: ms(wall),
        target: ms(TARGETS.waveMs),
      },
      {
        name: `session open while holding ${count}, p95`,
        ok: openP95 <= TARGETS.openP95Ms,
        measured: `${ms(openP95)} (p50 ${ms(percentile(after, 50))}, over ${after.length})`,
        target: ms(TARGETS.openP95Ms),
      },
      {
        name: "turn settled under the wave, p95",
        ok: settleP95 <= TARGETS.settleP95Ms,
        measured: `${ms(settleP95)} (p50 ${ms(percentile(settles, 50))})`,
        target: ms(TARGETS.settleP95Ms),
      },
      {
        name: "memory while holding them",
        ok: grown <= TARGETS.rssGrowthMb,
        measured: `+${grown.toFixed(0)} MB`,
        target: `+${TARGETS.rssGrowthMb} MB`,
      },
    ];
  } finally {
    await running.stop();
    rmSync(projectsDir, { recursive: true, force: true });
  }
}

/** The tables the upgrade drill writes into, chosen because they exist in every schema Perch has had. */
const OLD_TABLES = ["workspaces", "users", "channels"] as const;

/**
 * An upgrade: a database at the schema of the release before this one, migrated forward, with every
 * row it already held still in it and readable — and a backup written by that older Perch restored
 * into this one.
 */
export async function upgradeDrill(): Promise<Row[]> {
  const rows: Row[] = [];
  const all = embeddedMigrations().length;
  // One release's worth of change is however many migrations the newest release added; going back
  // to "everything but the last" is the smallest upgrade there is, and the one people do most.
  const before = Math.max(1, all - 1);

  // A database at the older schema, filled through SQL (the api of that release is not here to ask).
  const old = await createDb({ url: "pglite://memory" });
  try {
    await migrateTo(old.db, before);
    const workspace = crypto.randomUUID();
    const user = crypto.randomUUID();
    const authUser = crypto.randomUUID();
    const channel = crypto.randomUUID();
    await old.db.execute(sql`
      insert into workspaces (id, slug, name) values (${workspace}, 'old-nest', 'Old Nest')
    `);
    await old.db.execute(sql`
      insert into auth_user (id, name, email) values (${authUser}, 'Old', 'old@perch.test')
    `);
    await old.db.execute(sql`
      insert into users (id, auth_user_id, email, name, handle)
      values (${user}, ${authUser}, 'old@perch.test', 'Old', 'old')
    `);
    await old.db.execute(sql`
      insert into channels (id, workspace_id, type, name)
      values (${channel}, ${workspace}, 'public', 'general')
    `);
    const upgrade = await old.migrate();
    const counts: Record<string, number> = {};
    for (const table of OLD_TABLES) {
      const answer = await old.db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
      const list = Array.isArray(answer) ? answer : ((answer as { rows?: unknown[] }).rows ?? []);
      counts[table] = Number((list[0] as { n?: number } | undefined)?.n ?? 0);
    }
    const name = await old.db.execute(sql`select name from workspaces where id = ${workspace}`);
    const kept = Array.isArray(name) ? name : ((name as { rows?: unknown[] }).rows ?? []);
    rows.push({
      name: `a database ${all - before} migration(s) behind upgrades`,
      ok: upgrade.applied === all - before && upgrade.total === all,
      measured: `applied ${upgrade.applied} of ${upgrade.total}`,
      target: `${all - before} pending, ${all} total`,
    });
    rows.push({
      name: "every row written before the upgrade is still there",
      ok:
        OLD_TABLES.every((table) => counts[table] === 1) &&
        (kept[0] as { name?: string } | undefined)?.name === "Old Nest",
      measured: OLD_TABLES.map((table) => `${table}: ${counts[table]}`).join(", "),
      target: OLD_TABLES.map((table) => `${table}: 1`).join(", "),
    });
  } finally {
    await old.close();
  }

  // A backup taken by one instance, restored into an empty database that has only just been
  // migrated: the shape of an upgrade that moves machines as well as versions.
  const source = await bootTestApp();
  const target = await createDb({ url: "pglite://memory" });
  const serving = serve(source, { port: 0, hostname: "127.0.0.1" });
  try {
    const client = await signedIn(serving.url, source.env.publicUrl);
    const ws = await firstWorkspace(client);
    const made = await client.call(`/api/workspaces/${ws}/channels`, {
      method: "POST",
      json: { type: "public", name: "upgrade-drill", topic: "written before the upgrade" },
    });
    if (made.status !== 201) throw new Error(`channel: ${made.status} ${made.text.slice(0, 200)}`);
    const lines: string[] = [];
    const dumped = await dumpDatabase(source.db.db, (line) => {
      lines.push(line);
    });
    await target.migrate();
    const restored = await restoreDatabase(
      target.db,
      (async function* () {
        for (const line of lines) yield line.trimEnd();
      })(),
    );
    const back = await target.db.execute(
      sql`select name, topic from channels where name = 'upgrade-drill'`,
    );
    const list = Array.isArray(back) ? back : ((back as { rows?: unknown[] }).rows ?? []);
    const row = list[0] as { name?: string; topic?: string } | undefined;
    rows.push({
      name: "a backup restores into a database that was empty a moment ago",
      ok: restored.rows === dumped.rows && row?.topic === "written before the upgrade",
      measured: `${restored.rows} of ${dumped.rows} rows, across ${restored.tables} tables`,
      target: `${dumped.rows} rows`,
    });
  } finally {
    await serving.stop();
    await target.close();
  }
  return rows;
}

/**
 * A runner killed mid-turn. The turn was running on an agent process that has just gone away, so
 * nothing will ever answer it: what matters is that the session says so within the silence window
 * rather than sitting at `running` for ever, and that the workspace takes a new runner and works.
 */
export async function chaosDrill(): Promise<Row[]> {
  const silenceMs = 3_000;
  const agent = join(import.meta.dir, "..", "..", "runner", "test", "fixtures", "acp-agent.ts");
  const booted = await bootTestApp({}, { sessions: { silenceMs } });
  const projectsDir = mkdtempSync(join(tmpdir(), "perch-chaos-"));
  const runnerOptions = {
    projectsDir,
    portsIntervalMs: 0,
    sessions: {
      agents: { fake: { name: "Fake Agent", command: process.execPath, args: [agent] } },
      defaultAgent: "fake",
    },
  };
  const first = createInProcessRunner(runnerOptions);
  booted.runners.attach(first);
  const running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  try {
    const client = await signedIn(running.url, booted.env.publicUrl);
    const ws = await firstWorkspace(client);
    const project = await readyProject(client, ws, "Chaos");
    const created = (await client.call(`/api/workspaces/${ws}/projects/${project}/sessions`, {
      method: "POST",
      // The ACP lane on the fake agent: a real process on the runner, which is the thing the drill
      // is about to take away.
      // `slow` is the fixture's five-second turn: long enough for the machine under it to vanish
      // while it is still talking, which is the whole point of the drill.
      json: { engine: "acp", agent: "fake", prompt: "slow" },
    })) as { status: number; text: string; body: { id: string } };
    if (created.status !== 201) throw new Error(`session: ${created.status} ${created.text}`);
    const session = created.body.id;

    // …and it is really running before anything is killed. A session that had already failed for
    // its own reasons would otherwise sail through this drill.
    let wasRunning = false;
    let why = "";
    const startedBy = Date.now() + 15_000;
    while (Date.now() < startedBy) {
      const row = (await client.call(`/api/sessions/${session}`)) as {
        body: { status: string };
      };
      if (row.body.status === "running") {
        wasRunning = true;
        break;
      }
      if (row.body.status === "error") {
        why = JSON.stringify(row.body).slice(0, 300);
        break;
      }
      await Bun.sleep(50);
    }

    // Mid-turn, the machine the agent was on disappears.
    await booted.runners.closeAll();

    const died = performance.now();
    let status = "running";
    const deadline = Date.now() + TARGETS.recoverMs;
    while (Date.now() < deadline) {
      const row = (await client.call(`/api/sessions/${session}`)) as { body: { status: string } };
      status = row.body.status;
      if (status !== "running") break;
      await Bun.sleep(100);
    }
    const recovered = performance.now() - died;

    // …and the workspace is not finished: a new runner, a new project, a new session.
    booted.runners.attach(createInProcessRunner(runnerOptions));
    const after = await readyProject(client, ws, "After");
    const again = await client.call(`/api/workspaces/${ws}/projects/${after}/sessions`, {
      method: "POST",
      json: { engine: "acp", agent: "fake", prompt: "still here?" },
    });
    return [
      {
        name: "the turn was running when its runner died",
        ok: wasRunning,
        measured: wasRunning ? "running" : `it never started: ${why}`,
        target: "running",
      },
      {
        name: "a session whose runner died stops saying it is running",
        ok: wasRunning && status !== "running" && recovered <= TARGETS.recoverMs,
        measured: `${status} after ${ms(recovered)}`,
        target: `not running, within ${ms(TARGETS.recoverMs)}`,
      },
      {
        name: "the workspace takes a new runner and opens a new session",
        ok: again.status === 201,
        measured: `${again.status}`,
        target: "201",
      },
    ];
  } finally {
    await running.stop();
    rmSync(projectsDir, { recursive: true, force: true });
  }
}

export type DrillName = "load" | "upgrade" | "chaos";

export const DRILLS: Record<DrillName, (options?: { sessions?: number }) => Promise<Row[]>> = {
  load: (options = {}) => loadDrill(options),
  upgrade: () => upgradeDrill(),
  chaos: () => chaosDrill(),
};

export function report(rows: Row[]): string {
  return rows
    .map(
      (row) =>
        `${row.ok ? "ok  " : "FAIL"}  ${row.name.padEnd(52)} ${row.measured}  (target ${row.target})`,
    )
    .join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { only: { type: "string" }, sessions: { type: "string" } },
  });
  const names = (values.only ? [values.only] : Object.keys(DRILLS)) as DrillName[];
  const sessions = values.sessions ? Number(values.sessions) : undefined;
  let bad = 0;
  for (const name of names) {
    const drill = DRILLS[name];
    if (!drill) {
      console.error(`unknown drill: ${name} (have ${Object.keys(DRILLS).join(", ")})`);
      process.exit(2);
    }
    console.log(`\n── ${name} ──`);
    const rows = await drill(sessions === undefined ? {} : { sessions });
    console.log(report(rows));
    bad += rows.filter((row) => !row.ok).length;
  }
  console.log(
    bad === 0 ? "\nthe reliability bar holds" : `\n${bad} measurements missed their target`,
  );
  process.exit(bad === 0 ? 0 : 1);
}
