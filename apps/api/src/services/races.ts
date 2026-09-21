/**
 * Race mode (spec §5.7 "same task on two engines/models side by side; compare diffs, cost,
 * preflight; pick a winner"; task 3.16).
 *
 * The same question, asked of several engines at once, each in a worktree of its own. What comes
 * back is not one answer but a comparison — what each one changed, what it cost, and what the
 * project's checks made of it — and then somebody picks, or the checks do.
 *
 * Almost none of this is new machinery. An entrant is an ordinary session in an ordinary worktree
 * (task 3.14), the checks are the merge queue's checks (task 3.15), and the winner lands through
 * the queue like any other branch. What a race adds is the bookkeeping and the decision.
 */
import type { Bus } from "@perch/bus";
import type { Db, DbHandle, MessageBlock, Project, Race, RaceEntrant, WorkItem } from "@perch/db";
import { execResultSchema, type RunnerLink, worktreeCreateResultSchema } from "@perch/events";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { getMessage, insertMessage, updateMessageBlocks } from "../repos/messages.ts";
import { findProject } from "../repos/projects.ts";
import {
  anyRunning,
  claimDecision,
  entrantForSession,
  getEntrant,
  getRace,
  insertEntrant,
  insertRace,
  listEntrants,
  listRaces,
  updateEntrant,
  updateRace,
} from "../repos/races.ts";
import { getSession } from "../repos/sessions.ts";
import { getWorkItem, updateWorkItem } from "../repos/work.ts";
import { MergeQueueService } from "./merge-queue.ts";
import { projectRunnerLink } from "./projects.ts";
import { runnerCall } from "./runners.ts";
import type { SessionService } from "./sessions.ts";
import { identifierOf } from "./work.ts";

export type RaceDeps = {
  db: DbHandle;
  bus: Bus;
  log: Logger;
  sessions: SessionService;
  mergeQueue: MergeQueueService;
  registry: Parameters<typeof projectRunnerLink>[0]["registry"];
  raceCheckTimeoutMs?: number;
};

/** One entrant, as it is asked for. */
export type Runner = { engine: string; agent?: string | undefined };

export type StartRace = {
  project: Project;
  prompt: string;
  runners: Runner[];
  userId: string;
  workItem?: WorkItem | undefined;
  by: ActorContext;
};

const CHECK_TIMEOUT_MS = 10 * 60_000;

/** The branch one entrant works on: the item's branch with the engine on the end. */
export function entrantBranch(base: string, engine: string, agent?: string | null): string {
  const who = [engine, agent].filter(Boolean).join("-").toLowerCase();
  return `${base}/${who.replace(/[^a-z0-9._-]+/g, "-")}`;
}

export class RaceService {
  constructor(private readonly deps: RaceDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  /**
   * Start one, with a session per runner. Every entrant is asked the same words — a race is only
   * fair if the ask is the same — and each gets its own worktree, so what they write cannot
   * collide.
   */
  async start(input: StartRace): Promise<{ race: Race; entrants: RaceEntrant[] }> {
    if (input.runners.length < 2) {
      throw PerchError.validation("a race needs at least two engines to be a race");
    }
    if (input.runners.length > 8) throw PerchError.validation("eight engines is enough");
    // An entrant is its branch, and a branch is its engine and agent — so the same pair twice is
    // two entrants in one worktree, which is not a race and cannot be made into one.
    const seen = new Set<string>();
    for (const runner of input.runners) {
      const key = `${runner.engine}:${runner.agent ?? ""}`;
      if (seen.has(key)) {
        throw PerchError.validation("an engine can only enter a race once", {
          engine: runner.engine,
          ...(runner.agent ? { agent: runner.agent } : {}),
        });
      }
      seen.add(key);
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw PerchError.validation("say what they are all being asked");

    const race = await insertRace(this.db, {
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      prompt,
      createdBy: input.userId,
      ...(input.workItem ? { workItemId: input.workItem.id } : {}),
      ...(input.workItem?.threadRootId ? { threadRootId: input.workItem.threadRootId } : {}),
    });

    const stem = input.workItem
      ? `perch/${input.project.key.toLowerCase()}-${input.workItem.number}`
      : `perch/race-${race.id.slice(0, 8)}`;
    // Every entrant's row goes in before any of them is asked anything, because a round can
    // finish inside `sendTurn` — a fast engine, a cached answer — and two things go wrong if it
    // does. An entrant with no row yet cannot be found when its session ends, so it never
    // finishes; and a race whose other entrants do not exist yet looks over after the first one.
    const rows: RaceEntrant[] = [];
    for (const runner of input.runners) {
      rows.push(
        await insertEntrant(this.db, {
          raceId: race.id,
          branch: entrantBranch(stem, runner.engine, runner.agent),
          engine: runner.engine,
          ...(runner.agent ? { agent: runner.agent } : {}),
        }),
      );
    }

    await this.deps.bus.publish(
      "race.started",
      {
        workspaceId: race.workspaceId,
        projectId: race.projectId,
        raceId: race.id,
        entrants: rows.length,
      },
      input.by,
    );
    await this.card(race);

    for (const [index, runner] of input.runners.entries()) {
      const entrant = rows[index];
      if (!entrant) continue;
      try {
        const session = await this.deps.sessions.create({
          project: input.project,
          userId: input.userId,
          by: input.by,
          engine: runner.engine,
          worktree: entrant.branch,
          // An entrant is nobody's conversation: its round ending is what gets it measured and
          // compared, so it has to end rather than sit idle waiting for a turn (ADR-0133).
          unattended: true,
          title: `${runner.engine} · ${prompt.slice(0, 60)}`,
          ...(runner.agent ? { agent: runner.agent } : {}),
          ...(input.workItem ? { workItemId: input.workItem.id } : {}),
        });
        // The session id before the turn, not after: what finds this entrant when its session
        // ends is the id, and the round can be over before `sendTurn` returns.
        await updateEntrant(this.db, entrant.id, { sessionId: session.id });
        await this.deps.sessions.sendTurn(
          session,
          input.userId,
          { text: prompt },
          { by: input.by },
        );
      } catch (error) {
        // One engine being unavailable is not the race failing: it is that entrant failing, which
        // is a result and belongs on the card with the others.
        await updateEntrant(this.db, entrant.id, {
          state: "failed",
          detail: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        });
      }
    }

    await this.card(race);
    // An entrant that could not start does not hold the race up.
    if (!(await anyRunning(this.db, race.id))) await this.maybeDecide(race.id, input.userId);
    return {
      race: (await getRace(this.db, race.id)) ?? race,
      entrants: await listEntrants(this.db, race.id),
    };
  }

  race(id: string) {
    return getRace(this.db, id);
  }

  entrants(raceId: string) {
    return listEntrants(this.db, raceId);
  }

  races(projectId: string) {
    return listRaces(this.db, projectId);
  }

  /**
   * A person's decision (spec §5.7 "pick a winner"). The winner's branch goes to the merge queue
   * and every other entrant's worktree is given back — one diff applied, the rest discarded.
   */
  async pick(
    entrantId: string,
    input: { userId: string; by: ActorContext },
  ): Promise<{ race: Race; winner: RaceEntrant }> {
    const winner = await getEntrant(this.db, entrantId);
    if (!winner) throw PerchError.notFound("entrant");
    const race = await getRace(this.db, winner.raceId);
    if (!race) throw PerchError.notFound("race");
    if (race.state === "decided") throw PerchError.conflict("that race already has a winner");
    return this.decide(race, winner, "person", input.userId, input.by);
  }

  /** The bus half: an entrant's session ending is that entrant finishing. */
  watch(): () => void {
    return this.deps.bus.subscribe("session.status", (event) => {
      if (event.payload.status !== "ended" && event.payload.status !== "error") return;
      void this.finished(event.payload.sessionId).catch((error: unknown) => {
        this.deps.log.error({ err: error }, "a race entrant could not be finished");
      });
    });
  }

  private async finished(sessionId: string): Promise<void> {
    const entrant = await entrantForSession(this.db, sessionId);
    if (entrant?.state !== "running") return;
    const race = await getRace(this.db, entrant.raceId);
    if (race?.state !== "running") return;
    const session = await getSession(this.db, sessionId);
    const project = await findProject(this.db, race.workspaceId, race.projectId);

    let measured: Partial<RaceEntrant> = {};
    if (project && session) {
      measured = await this.measure(project, entrant, session.userId);
    }
    await updateEntrant(this.db, entrant.id, {
      state: session?.status === "error" ? "failed" : "finished",
      finishedAt: new Date(),
      ...(session ? { costUsd: String(session.costUsd) } : {}),
      ...measured,
    });
    await this.deps.bus.publish(
      "race.entrant_finished",
      {
        workspaceId: race.workspaceId,
        projectId: race.projectId,
        raceId: race.id,
        entrantId: entrant.id,
        engine: entrant.engine,
        state: session?.status === "error" ? "failed" : "finished",
      },
      { actor: { type: "system" }, meta: {} },
    );
    await this.card(race);
    if (!(await anyRunning(this.db, race.id))) {
      await this.maybeDecide(race.id, session?.userId ?? race.createdBy ?? "");
    }
  }

  /**
   * What this entrant did, in the three numbers a person compares: how much it changed, what it
   * cost, and what the checks said. Best effort — an entrant that cannot be measured is still an
   * entrant, and says so on the card.
   */
  private async measure(
    project: Project,
    entrant: RaceEntrant,
    userId: string,
  ): Promise<Partial<RaceEntrant>> {
    let link: RunnerLink;
    try {
      link = await projectRunnerLink(
        { db: this.db, registry: this.deps.registry },
        project,
        userId,
      );
    } catch {
      return {};
    }
    const out: Partial<RaceEntrant> = {};
    let cwd: string | null = null;
    try {
      const raw = await runnerCall(link, "worktree.create", {
        workspace_id: project.workspaceId,
        user_id: userId,
        project: project.id,
        branch: entrant.branch,
        base: project.defaultBranch,
      });
      cwd = worktreeCreateResultSchema.parse(raw).path;
    } catch {
      return out;
    }

    // The diff against the branch it came off, in the numbers a card shows.
    try {
      const raw = await runnerCall(link, "exec", {
        workspace_id: project.workspaceId,
        user_id: userId,
        command: `git diff --shortstat ${project.defaultBranch}...HEAD`,
        cwd,
        timeout: 60_000,
      });
      const { stdout } = execResultSchema.parse(raw);
      const files = /(\d+) files? changed/.exec(stdout)?.[1];
      const plus = /(\d+) insertions?/.exec(stdout)?.[1];
      const minus = /(\d+) deletions?/.exec(stdout)?.[1];
      if (files) out.filesChanged = Number(files);
      out.additions = plus ? Number(plus) : 0;
      out.deletions = minus ? Number(minus) : 0;
    } catch (error) {
      this.deps.log.warn({ err: error, entrantId: entrant.id }, "an entrant's diff was not read");
    }

    // And the project's own checks, the same ones the merge queue would hold it to.
    const checks = MergeQueueService.checkCommand(project);
    if (checks) {
      try {
        const raw = await runnerCall(link, "exec", {
          workspace_id: project.workspaceId,
          user_id: userId,
          command: checks.command,
          cwd,
          timeout: this.deps.raceCheckTimeoutMs ?? CHECK_TIMEOUT_MS,
        });
        const result = execResultSchema.parse(raw);
        out.checksExitCode = result.exitCode ?? 1;
        out.checksOutput = tail(`${result.stdout}\n${result.stderr}`);
      } catch (error) {
        this.deps.log.warn(
          { err: error, entrantId: entrant.id },
          "an entrant's checks did not run",
        );
      }
    }
    return out;
  }

  /**
   * The checks deciding, when nobody has (spec §5.7 "a winner chosen by a person or by the
   * checks"). Only a project that has checks can decide by itself: without them there is nothing
   * to prefer one diff over another, and guessing would be worse than waiting for a person.
   */
  private async maybeDecide(raceId: string, userId: string): Promise<void> {
    const race = await getRace(this.db, raceId);
    if (race?.state !== "running") return;
    const all = await listEntrants(this.db, raceId);
    const passed = all.filter((one) => one.state === "finished" && one.checksExitCode === 0);
    if (passed.length === 0) {
      await this.card(race);
      return;
    }
    // The cheapest of the ones that pass, and the smallest diff to break a tie: a race is won by
    // the answer that works, and among those by the one that asked for the least.
    const winner = [...passed].sort((a, b) => {
      const cost = Number(a.costUsd ?? 0) - Number(b.costUsd ?? 0);
      if (cost !== 0) return cost;
      return (a.additions ?? 0) + (a.deletions ?? 0) - ((b.additions ?? 0) + (b.deletions ?? 0));
    })[0];
    if (!winner) return;
    try {
      await this.decide(race, winner, "checks", userId, { actor: { type: "system" }, meta: {} });
    } catch (error) {
      // The other entrant finishing in the same moment got there first: nothing to do twice.
      if (error instanceof PerchError && error.code === "conflict") return;
      throw error;
    }
  }

  private async decide(
    race: Race,
    winner: RaceEntrant,
    by: "person" | "checks",
    userId: string,
    actor: ActorContext,
  ): Promise<{ race: Race; winner: RaceEntrant }> {
    // One decision per race (ADR-0132): the first to claim the transition decides; anybody else
    // arriving — the other entrant finishing in the same moment, a second press — is told so.
    const decided = await claimDecision(this.db, race.id, {
      winnerId: winner.id,
      decidedBy: by,
      decidedAt: new Date(),
      ...(by === "person" && userId ? { decidedByUserId: userId } : {}),
    });
    if (!decided) throw PerchError.conflict("this race has already been decided");
    const won = (await updateEntrant(this.db, winner.id, { state: "won" })) ?? winner;

    const project = await findProject(this.db, race.workspaceId, race.projectId);
    const item = race.workItemId ? await getWorkItem(this.db, race.workItemId) : null;

    // The winner's diff is applied by landing it, the way any other branch lands (task 3.15).
    if (project) {
      try {
        await this.deps.mergeQueue.add({
          project,
          branch: winner.branch,
          userId: userId || (race.createdBy ?? ""),
          by: actor,
          ...(item ? { workItem: item } : {}),
          ...(winner.sessionId ? { sessionId: winner.sessionId } : {}),
        });
      } catch (error) {
        this.deps.log.warn(
          { err: error, raceId: race.id, branch: winner.branch },
          "the winner could not be queued",
        );
      }
    }

    // And the rest are given back: their worktrees go, their branches stay.
    for (const entrant of await listEntrants(this.db, race.id)) {
      if (entrant.id === winner.id) continue;
      await updateEntrant(this.db, entrant.id, { state: "discarded" });
      if (!entrant.sessionId) continue;
      const session = await getSession(this.db, entrant.sessionId);
      if (session) await this.deps.sessions.dropWorktree(session, session.userId);
    }

    await this.deps.bus.publish(
      "race.decided",
      {
        workspaceId: race.workspaceId,
        projectId: race.projectId,
        raceId: race.id,
        winnerId: winner.id,
        decidedBy: by,
      },
      actor,
    );
    if (item && item.state !== "done" && item.state !== "cancelled") {
      await updateWorkItem(this.db, item.id, { state: "in_review" });
    }
    await this.card(decided);
    return { race: decided, winner: won };
  }

  /** One card per race, rewritten in place: the comparison a person is being asked to make. */
  private async card(race: Race): Promise<void> {
    if (!race.threadRootId) return;
    const project = await findProject(this.db, race.workspaceId, race.projectId);
    const item = race.workItemId ? await getWorkItem(this.db, race.workItemId) : null;
    const entrants = await listEntrants(this.db, race.id);
    const block: MessageBlock = {
      type: "race_card",
      raceId: race.id,
      state: race.state,
      ...(item && project ? { identifier: identifierOf(project.key, item.number) } : {}),
      ...(race.decidedBy ? { decidedBy: race.decidedBy } : {}),
      entrants: entrants.map((one) => ({
        id: one.id,
        engine: one.engine,
        branch: one.branch,
        state: one.state,
        ...(one.costUsd !== null ? { costUsd: Number(one.costUsd) } : {}),
        ...(one.filesChanged !== null ? { filesChanged: one.filesChanged } : {}),
        ...(one.additions !== null ? { additions: one.additions } : {}),
        ...(one.deletions !== null ? { deletions: one.deletions } : {}),
        ...(one.checksExitCode !== null ? { checks: one.checksExitCode } : {}),
        ...(one.detail ? { detail: one.detail.slice(0, 2000) } : {}),
      })),
    };

    if (race.cardMessageId) {
      const card = await getMessage(this.db, race.cardMessageId);
      if (card) {
        await updateMessageBlocks(this.db, card, [block], {
          type: "system",
          id: race.id,
          history: false,
        });
      }
      return;
    }
    const root = await getMessage(this.db, race.threadRootId);
    if (!root) return;
    const message = await insertMessage(this.db, {
      workspaceId: race.workspaceId,
      channelId: root.channelId,
      authorType: "system",
      authorId: race.createdBy ?? race.id,
      blocks: [block],
      threadRootId: race.threadRootId,
    });
    await updateRace(this.db, race.id, { cardMessageId: message.id });
  }
}

function tail(text: string, max = 2_000): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}
