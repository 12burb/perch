import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, schema } from "@perch/db";
import { generateMasterKey } from "@perch/vault";
import { and, eq } from "drizzle-orm";
import { type Booted, boot, INTERRUPTED } from "../src/boot.ts";
import { loadEnv } from "../src/env.ts";
import { silentLogger } from "../src/logging.ts";
import { startRun } from "../src/repos/bots.ts";
import { enqueue, getEntry, updateEntry } from "../src/repos/merge.ts";
import { getEntrant, insertEntrant, insertRace } from "../src/repos/races.ts";
import { getSession, insertSession, listEvents, updateSession } from "../src/repos/sessions.ts";
import { getWorkItem, insertWorkItem } from "../src/repos/work.ts";
import { bootTestApp, TEST_ADMIN } from "../src/testing.ts";

/**
 * What a restart leaves behind (ADR-0165, ADR-0177). A session's round, a bot's run and a landing
 * all live in the process that started them; after a restart nothing will ever finish them, so the
 * process that owns that work settles it at boot — and only that process: the supervisor and a
 * backup boot beside a running api, and settling from there would fail the api's own work.
 *
 * Three boots over one PGlite directory: the one that leaves the mess, one the way the supervisor
 * boots (which must leave it alone), and one the way the api boots (which must clear it up).
 */

const dir = mkdtempSync(join(tmpdir(), "perch-restart-"));
const masterKey = generateMasterKey();
const overrides = {
  DATABASE_URL: `pglite://${join(dir, "db")}`,
  PERCH_MASTER_KEY: masterKey,
  PERCH_LOG_LEVEL: "silent",
  PERCH_DATA_DIR: join(dir, "data"),
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A later boot over the same database, the way an entrypoint boots it. */
function bootAgain(recover: boolean | undefined): Promise<Booted> {
  return boot({
    env: loadEnv(overrides),
    log: silentLogger(),
    mergeQueueResumeMs: 50,
    ...(recover === undefined ? {} : { recover }),
  });
}

async function until(check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("it never happened");
}

/** Everything the first process left mid-flight, by id. */
type Left = {
  settingUp: string;
  running: string;
  asking: string;
  idle: string;
  item: string;
  entrant: string;
  run: string;
  hop: string;
  landing: string;
  waiting: string;
  owner: string;
};

async function leaveItRunning(db: Db): Promise<Left> {
  const [owner] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, TEST_ADMIN.email));
  const [workspace] = await db.select().from(schema.workspaces).limit(1);
  if (!owner || !workspace) throw new Error("setup made no admin or workspace");
  const workspaceId = workspace.id;
  const [project] = await db
    .insert(schema.projects)
    .values({ workspaceId, key: "RS", name: "restart", status: "ready", createdBy: owner.id })
    .returning();
  const [settingUp] = await db
    .insert(schema.projects)
    .values({ workspaceId, key: "SU", name: "setting-up", status: "setting_up" })
    .returning();
  if (!project || !settingUp) throw new Error("no projects");
  const projectId = project.id;

  const session = async (status: "running" | "needs_you" | "idle") => {
    const row = await insertSession(db, {
      workspaceId,
      projectId,
      runnerId: null,
      userId: owner.id,
      engine: "fake",
      model: { provider: "fake", modelId: "fake" },
      mode: "build",
      title: status,
    });
    await updateSession(db, row.id, { status });
    return row.id;
  };
  const running = await session("running");
  const asking = await session("needs_you");
  const idle = await session("idle");

  // The board shows the running one working on an item, and a race waits on the asking one.
  const item = await insertWorkItem(db, {
    workspaceId,
    projectId,
    title: "Fix the header",
    state: "running",
    sessionId: running,
  });
  const race = await insertRace(db, { workspaceId, projectId, prompt: "fix it" });
  const entrant = await insertEntrant(db, {
    raceId: race.id,
    branch: "perch/race/fake",
    engine: "fake",
    sessionId: asking,
  });

  // A bot halfway through answering, as one hop of a chain.
  const [bot] = await db
    .insert(schema.bots)
    .values({ workspaceId, handle: "wren", name: "Wren", ownerId: owner.id })
    .returning();
  const [channel] = await db
    .insert(schema.channels)
    .values({ workspaceId, type: "public", name: "restart" })
    .returning();
  if (!bot || !channel) throw new Error("no bot or channel");
  const [root] = await db
    .insert(schema.messages)
    .values({ workspaceId, channelId: channel.id, authorType: "user", authorId: owner.id })
    .returning();
  if (!root) throw new Error("no message");
  const run = await startRun(db, { workspaceId, botId: bot.id, trigger: "mention" });
  const [hop] = await db
    .insert(schema.botChains)
    .values({
      workspaceId,
      threadRootId: root.id,
      fromType: "user",
      fromId: owner.id,
      toBotId: bot.id,
    })
    .returning();
  if (!hop) throw new Error("no hop");

  // A landing claimed a minute ago — inside its lease — and a branch waiting behind it.
  const landing = await enqueue(db, {
    workspaceId,
    projectId,
    branch: "perch/landing",
    base: "main",
    requestedBy: owner.id,
  });
  await updateEntry(db, landing.id, {
    state: "landing",
    startedAt: new Date(Date.now() - 60_000),
  });
  const waiting = await enqueue(db, {
    workspaceId,
    projectId,
    branch: "perch/waiting",
    base: "main",
    requestedBy: owner.id,
  });

  return {
    settingUp: settingUp.id,
    running,
    asking,
    idle,
    item: item.id,
    entrant: entrant.id,
    run: run.id,
    hop: hop.id,
    landing: landing.id,
    waiting: waiting.id,
    owner: owner.id,
  };
}

let left: Left;

describe("a restart (ADR-0165, ADR-0177)", () => {
  test("the first process leaves sessions, runs, a setup and a landing in flight", async () => {
    const first = await bootTestApp(overrides);
    try {
      left = await leaveItRunning(first.db.db);
    } finally {
      await first.close();
    }
  }, 120_000);

  test("a process that does not own that work (the supervisor, a backup) leaves it alone (A-co-16)", async () => {
    const supervisor = await bootAgain(false);
    try {
      // Long enough for a queue timer to have fired many times, had one been started.
      await Bun.sleep(500);
      const db = supervisor.db.db;
      const [project] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, left.settingUp));
      expect(project?.status).toBe("setting_up");
      expect((await getSession(db, left.running))?.status).toBe("running");
      expect((await getSession(db, left.asking))?.status).toBe("needs_you");
      const [run] = await db.select().from(schema.botRuns).where(eq(schema.botRuns.id, left.run));
      expect(run?.status).toBe("running");
      expect((await getEntry(db, left.landing))?.state).toBe("landing");
      expect((await getEntry(db, left.waiting))?.state).toBe("waiting");
    } finally {
      await supervisor.close();
    }
  }, 120_000);

  test("the api that boots next ends what was interrupted and says so, so what waits on it moves (X-data-14, A-sm-12)", async () => {
    const api = await bootAgain(undefined);
    try {
      const db = api.db.db;
      // The setup is failed, as before (ADR-0165).
      const [project] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, left.settingUp));
      expect(project?.status).toBe("error");

      // Sessions mid-round, or stopped on a permission nobody can answer now, are errors with the
      // reason; one that was between rounds is untouched.
      for (const id of [left.running, left.asking]) {
        const session = await getSession(db, id);
        expect(session?.status).toBe("error");
        expect(session?.statusMessage).toBe(INTERRUPTED);
        // And the transcript says what happened.
        const events = await listEvents(db, id);
        expect(events.at(-1)?.event).toEqual({ type: "error", message: INTERRUPTED });
      }
      expect((await getSession(db, left.idle))?.status).toBe("idle");

      // `session.status` went out: the board and the race followed it.
      await until(async () => (await getWorkItem(db, left.item))?.state === "needs_you");
      await until(async () => (await getEntrant(db, left.entrant))?.state === "failed");

      // The bot's run and its hop are over, and the bot's owner is told it could not answer.
      const [run] = await db.select().from(schema.botRuns).where(eq(schema.botRuns.id, left.run));
      expect(run?.status).toBe("error");
      expect(run?.error).toBe(INTERRUPTED);
      expect(run?.endedAt).not.toBeNull();
      const [hop] = await db
        .select()
        .from(schema.botChains)
        .where(eq(schema.botChains.id, left.hop));
      expect(hop?.status).toBe("error");
      await until(async () => {
        const told = await db
          .select()
          .from(schema.inboxItems)
          .where(
            and(eq(schema.inboxItems.userId, left.owner), eq(schema.inboxItems.refId, left.run)),
          );
        return told.length === 1;
      });

      // And the merge queue is picked up without anything new being queued (X-data-13): the
      // landing the old process claimed is released at once rather than after its lease, and the
      // branch behind it is taken (there is no runner here, so it fails rather than lands).
      await until(async () => (await getEntry(db, left.landing))?.state === "failed");
      expect((await getEntry(db, left.landing))?.detail ?? "").toContain("interrupted");
      await until(async () => {
        const state = (await getEntry(db, left.waiting))?.state;
        return state !== "waiting" && state !== "landing";
      });
    } finally {
      await api.mergeQueue.settled(30_000);
      await api.close();
    }
  }, 120_000);
});
