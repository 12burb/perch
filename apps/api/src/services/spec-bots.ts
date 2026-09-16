/**
 * Spec bots, synced from a project's repository (spec §5.3 "hot-reload on push"; task 3.1).
 *
 * The repository is the source of truth. A sync reads `bots/<handle>/` on the project's runner,
 * turns each directory into a bot, and makes the workspace's bots match: new directories become
 * bots, changed ones are rewritten, and a directory that is gone takes its bot with it. A bot made
 * in the Forge is never touched — this service only ever looks at rows that name this project.
 *
 * A directory Perch cannot read is not a reason to lose the rest: the error is kept on the row, the
 * bot is paused, and every other bot in the repository still syncs.
 */

import {
  botDirOf,
  parseSpecBot,
  SPEC_BOT_FILE,
  SPEC_BOTS_DIR,
  SPEC_PERSONA_FILE,
  SPEC_SKILLS_DIR,
  type SpecBot,
  SpecBotError,
  type SpecBotFiles,
} from "@perch/bots/spec";
import type { Bot, Db, NewBot, Project } from "@perch/db";
import type { RunnerLink } from "@perch/events";
import type { Logger } from "../logging.ts";
import { deleteBot, findBotByHandle, insertBot, listSpecBots, updateBot } from "../repos/bots.ts";
import type { BotsService } from "./bots.ts";
import { runnerCall } from "./runners.ts";

/** Files bigger than this are not a bot definition; a repository is not asked to prove it. */
const MAX_BOT_FILE_BYTES = 200_000;
/** How many bot directories one sync reads. */
const MAX_BOTS = 50;
/** How many skills one bot may carry, matching `botSpecSchema`. */
const MAX_SKILLS = 20;

export type SpecBotsDeps = {
  db: Db;
  /** A synced bot's `schedule` triggers become cron jobs like any other bot's (task 2.6). */
  bots: Pick<BotsService, "reschedule">;
  log: Logger;
};

/** What a sync did, in the shape the route answers and the Git panel shows. */
export type SpecBotSync = {
  added: string[];
  updated: string[];
  removed: string[];
  /** A directory that could not be read, and why. Nothing else in the repository is held up by it. */
  failed: { handle: string; error: string }[];
};

type Ctx = { workspaceId: string; userId: string; projectId: string };

type Entry = { name: string; type: "file" | "dir" | "symlink" | "other"; size: number };

export class SpecBotsService {
  constructor(private readonly deps: SpecBotsDeps) {}

  private async list(link: RunnerLink, ctx: Ctx, at: string): Promise<Entry[]> {
    const raw = (await runnerCall(link, "fs.list", {
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      project: ctx.projectId,
      path: at,
    }).catch(() => null)) as {
      entries?: { name?: unknown; type?: unknown; size?: unknown }[];
    } | null;
    const out: Entry[] = [];
    for (const entry of raw?.entries ?? []) {
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!name) continue;
      const type =
        entry.type === "dir" || entry.type === "symlink" || entry.type === "other"
          ? entry.type
          : "file";
      out.push({ name, type, size: typeof entry.size === "number" ? entry.size : 0 });
    }
    return out;
  }

  private async read(link: RunnerLink, ctx: Ctx, path: string): Promise<string | null> {
    const raw = (await runnerCall(link, "fs.read", {
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      project: ctx.projectId,
      path,
    }).catch(() => null)) as { content?: unknown; encoding?: unknown } | null;
    if (!raw || typeof raw.content !== "string" || raw.encoding === "base64") return null;
    return raw.content;
  }

  /** Every `skills/**\/SKILL.md` under one bot, two directories deep, which is as deep as it goes. */
  private async skillsOf(link: RunnerLink, ctx: Ctx, dir: string): Promise<SpecBotFiles["skills"]> {
    const root = `${SPEC_BOTS_DIR}/${dir}/${SPEC_SKILLS_DIR}`;
    const out: { path: string; text: string }[] = [];
    for (const entry of await this.list(link, ctx, root)) {
      if (out.length >= MAX_SKILLS) break;
      const at = `${root}/${entry.name}`;
      if (entry.type === "file" && entry.name.toUpperCase() === "SKILL.MD") {
        const text = await this.read(link, ctx, at);
        if (text !== null) out.push({ path: `${SPEC_SKILLS_DIR}/${entry.name}`, text });
        continue;
      }
      if (entry.type !== "dir") continue;
      for (const inner of await this.list(link, ctx, at)) {
        if (inner.type !== "file" || inner.name.toUpperCase() !== "SKILL.MD") continue;
        if (inner.size > MAX_BOT_FILE_BYTES) continue;
        const text = await this.read(link, ctx, `${at}/${inner.name}`);
        if (text !== null) {
          out.push({ path: `${SPEC_SKILLS_DIR}/${entry.name}/${inner.name}`, text });
        }
      }
    }
    return out;
  }

  /** Reads one bot directory. `null` when there is no `bot.yaml`, which means it is not a bot. */
  private async readBot(link: RunnerLink, ctx: Ctx, dir: string): Promise<SpecBot | null> {
    const yaml = await this.read(link, ctx, `${SPEC_BOTS_DIR}/${dir}/${SPEC_BOT_FILE}`);
    if (yaml === null) return null;
    const systemMd = await this.read(link, ctx, `${SPEC_BOTS_DIR}/${dir}/${SPEC_PERSONA_FILE}`);
    return parseSpecBot(dir, {
      yaml,
      ...(systemMd === null ? {} : { systemMd }),
      skills: await this.skillsOf(link, ctx, dir),
    });
  }

  /**
   * Makes the workspace's spec bots match what is in the repository. Idempotent: syncing twice
   * without a change to the files changes nothing and says so.
   */
  async sync(link: RunnerLink, project: Project, userId: string): Promise<SpecBotSync> {
    const ctx: Ctx = { workspaceId: project.workspaceId, userId, projectId: project.id };
    const existing = await listSpecBots(this.deps.db, project.id);
    const byPath = new Map<string, Bot>(existing.map((bot) => [bot.sourcePath ?? bot.handle, bot]));
    const report: SpecBotSync = { added: [], updated: [], removed: [], failed: [] };
    const seen = new Set<string>();

    const dirs = (await this.list(link, ctx, SPEC_BOTS_DIR))
      .filter((entry) => entry.type === "dir")
      .slice(0, MAX_BOTS);

    for (const entry of dirs) {
      const path = `${SPEC_BOTS_DIR}/${entry.name}`;
      const was = byPath.get(path);
      let parsed: SpecBot | null = null;
      try {
        parsed = await this.readBot(link, ctx, entry.name);
      } catch (error) {
        const message =
          error instanceof SpecBotError || error instanceof Error ? error.message : String(error);
        report.failed.push({ handle: entry.name, error: message });
        // A bot whose files stopped making sense stops answering, and says why on its row.
        if (was) {
          seen.add(path);
          const row = await updateBot(this.deps.db, was.id, {
            status: "paused",
            sourceError: message,
          });
          if (row) await this.deps.bots.reschedule(row);
        }
        continue;
      }
      if (!parsed) continue;
      seen.add(path);

      const values: Partial<NewBot> = {
        handle: parsed.handle,
        name: parsed.name,
        level: "spec",
        spec: parsed.spec,
        visibility: parsed.visibility,
        orchestrator: parsed.orchestrator,
        budget: parsed.budget,
        status: "active",
        sourceProjectId: project.id,
        sourcePath: path,
        sourceError: null,
      };

      if (was) {
        if (!changed(was, values)) continue;
        const row = await updateBot(this.deps.db, was.id, values);
        if (row) await this.deps.bots.reschedule(row);
        report.updated.push(parsed.handle);
        continue;
      }
      // A handle is a name people type; a repository may not take one the workspace already uses.
      const taken = await findBotByHandle(this.deps.db, project.workspaceId, parsed.handle);
      if (taken) {
        report.failed.push({
          handle: parsed.handle,
          error: `@${parsed.handle} is already a bot in this workspace`,
        });
        continue;
      }
      const row = await insertBot(this.deps.db, {
        ...(values as NewBot),
        workspaceId: project.workspaceId,
        ownerId: userId,
      });
      await this.deps.bots.reschedule(row);
      report.added.push(parsed.handle);
    }

    for (const [path, bot] of byPath) {
      if (seen.has(path)) continue;
      await this.deps.bots.reschedule({ ...bot, status: "disabled" });
      await deleteBot(this.deps.db, bot.id);
      report.removed.push(bot.handle);
    }
    this.deps.log.info(
      {
        projectId: project.id,
        added: report.added.length,
        updated: report.updated.length,
        removed: report.removed.length,
        failed: report.failed.length,
      },
      "spec bots synced",
    );
    return report;
  }
}

/**
 * Whether a sync would actually change the row, so an unchanged repository is a no-op.
 *
 * The comparison is order-insensitive because jsonb is: what Postgres hands back has its keys in
 * its own order, not the one they were written in, and a repository nobody touched must not look
 * like a repository that changed.
 */
function changed(was: Bot, values: Partial<NewBot>): boolean {
  return (
    was.handle !== values.handle ||
    was.name !== values.name ||
    was.visibility !== values.visibility ||
    was.orchestrator !== values.orchestrator ||
    was.status !== values.status ||
    was.sourceError !== values.sourceError ||
    !same(was.spec, values.spec) ||
    !same(was.budget, values.budget)
  );
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((one, at) => same(one, b[at]))
    );
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!same(left[key], right[key])) return false;
  }
  return true;
}

/** Whether a set of changed paths could have changed a bot (spec §5.3 "hot-reload on push"). */
export function touchesBots(paths: readonly string[]): boolean {
  return paths.some((path) => botDirOf(path) !== null);
}
