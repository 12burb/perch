/**
 * The merge queue (spec §5.7 "merge queue with rebase, conflict detection, 'ask the agent to
 * resolve'"; task 3.15).
 *
 * Task 3.14 gave every work item its own worktree, so three agents can write three branches at
 * once without treading on each other. This is what happens next: the branches land one at a
 * time, each rebased onto what landed before it and each held to the project's own checks.
 *
 * Three things follow from "one at a time" and are the whole design:
 *
 * - **The queue is per project, and serial.** `claimNext` moves a row from waiting to landing in
 *   one update, so two api processes cannot both be landing. A project lands one branch at a
 *   time or the rebases are racing each other.
 * - **A failure is not the queue's problem to solve.** A branch that conflicts, or whose checks
 *   go red, is sent back to the agent that wrote it as a turn in its own session — which is what
 *   §5.7 means by "ask the agent to resolve". The queue moves on to the next branch rather than
 *   stopping.
 * - **The card is the surface.** One `queue_card` in the work item's thread, rewritten in place
 *   as the entry moves, so a thread reads as one queue rather than four notifications.
 */
import type { Bus } from "@perch/bus";
import type {
  Db,
  DbHandle,
  MergeFailure,
  MergeQueueEntry,
  MessageBlock,
  Project,
  WorkItem,
} from "@perch/db";
import {
  execResultSchema,
  gitMergeResultSchema,
  type RunnerLink,
  worktreeCreateResultSchema,
} from "@perch/events";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  claimNext,
  enqueue,
  getEntry,
  landing,
  listQueue,
  staleLanding,
  updateEntry,
  waitingFor,
} from "../repos/merge.ts";
import { insertMessage, updateMessageBlocks } from "../repos/messages.ts";
import { findProject } from "../repos/projects.ts";
import { getSession } from "../repos/sessions.ts";
import { getWorkItem, updateWorkItem } from "../repos/work.ts";
import { projectRunnerLink } from "./projects.ts";
import { runnerCall } from "./runners.ts";
import type { SessionService } from "./sessions.ts";
import { identifierOf } from "./work.ts";

export type MergeQueueDeps = {
  db: DbHandle;
  bus: Bus;
  log: Logger;
  sessions: SessionService;
  registry: Parameters<typeof projectRunnerLink>[0]["registry"];
  queueCheckTimeoutMs?: number;
};

/** How long a project's checks may take before the queue calls it a failure. */
const CHECK_TIMEOUT_MS = 15 * 60_000;
/** Beyond the checks' budget, how long a landing may go on before it counts as abandoned. */
const LANDING_GRACE_MS = 5 * 60_000;

/** The commands a project's `run` map might call its checks, in the order they are looked for. */
const CHECK_KEYS = ["check", "test", "ci", "verify"] as const;

export type QueueRequest = {
  project: Project;
  branch: string;
  userId: string;
  workItem?: WorkItem | undefined;
  sessionId?: string | undefined;
  base?: string | undefined;
  by: ActorContext;
};

export class MergeQueueService {
  /** Projects with a landing loop already running in this process. */
  private readonly running = new Set<string>();
  /** Resolves when nothing is landing, which is what the tests wait on. */
  private readonly idle: Array<() => void> = [];

  constructor(private readonly deps: MergeQueueDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  /** The command this project calls its checks, if it has one (`.perch/project.json` `run`). */
  static checkCommand(project: Project): { key: string; command: string } | null {
    const run = project.config.run ?? {};
    for (const key of CHECK_KEYS) {
      const command = run[key];
      if (command) return { key, command };
    }
    return null;
  }

  /** Put a branch in the queue. The same branch twice is the place it already had. */
  async add(input: QueueRequest): Promise<MergeQueueEntry> {
    const already = await waitingFor(this.db, input.project.id, input.branch);
    if (already) return already;
    const entry = await enqueue(this.db, {
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      branch: input.branch,
      base: input.base ?? input.project.defaultBranch,
      requestedBy: input.userId,
      ...(input.workItem ? { workItemId: input.workItem.id } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.workItem?.threadRootId ? { threadRootId: input.workItem.threadRootId } : {}),
    });
    await this.deps.bus.publish(
      "merge.queued",
      {
        workspaceId: entry.workspaceId,
        projectId: entry.projectId,
        entryId: entry.id,
        branch: entry.branch,
        position: entry.position,
      },
      input.by,
    );
    await this.card(entry, input.project);
    this.pump(input.project.id, input.userId);
    return entry;
  }

  queue(projectId: string, states?: readonly MergeQueueEntry["state"][]) {
    return listQueue(this.db, projectId, states);
  }

  entry(id: string) {
    return getEntry(this.db, id);
  }

  /** Waits until this project's queue has nothing left to land. */
  async settled(timeoutMs = 60_000): Promise<void> {
    const stop = Date.now() + timeoutMs;
    while (Date.now() < stop) {
      if (this.running.size === 0) return;
      await new Promise<void>((resolve) => {
        this.idle.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  /**
   * The landing loop, one per project. Started whenever something joins the queue and stopped
   * when the queue is empty, so an idle project costs nothing.
   */
  private pump(projectId: string, userId: string): void {
    if (this.running.has(projectId)) return;
    this.running.add(projectId);
    void (async () => {
      try {
        // A landing older than the longest a check may run plus a margin was abandoned — by an
        // api that restarted, or a check that never answered — and is failed rather than waited
        // on for ever (ADR-0165). Anything nearer than that is still somebody's in-flight work.
        const lease = (this.deps.queueCheckTimeoutMs ?? CHECK_TIMEOUT_MS) + LANDING_GRACE_MS;
        for (const stale of await staleLanding(this.db, projectId, new Date(Date.now() - lease))) {
          await this.failed(
            stale,
            "runner",
            "the landing was interrupted and never finished; queue the branch again",
            { actor: { type: "system" }, meta: {} },
          );
        }
        for (;;) {
          if (await landing(this.db, projectId)) return;
          const entry = await claimNext(this.db, projectId);
          if (!entry) return;
          await this.land(entry, userId);
        }
      } catch (error) {
        this.deps.log.error({ err: error, projectId }, "the merge queue stopped");
      } finally {
        this.running.delete(projectId);
        for (const wake of this.idle.splice(0)) wake();
      }
    })();
  }

  /** One branch: rebase it onto the base, run the checks, land it. Any of the three can say no. */
  private async land(entry: MergeQueueEntry, userId: string): Promise<void> {
    const by: ActorContext = { actor: { type: "system" }, meta: {} };
    const project = await findProject(this.db, entry.workspaceId, entry.projectId);
    if (!project) {
      await this.failed(entry, "runner", "the project is gone", by);
      return;
    }
    await this.deps.bus.publish(
      "merge.landing",
      {
        workspaceId: entry.workspaceId,
        projectId: entry.projectId,
        entryId: entry.id,
        branch: entry.branch,
      },
      by,
    );
    await this.card(entry, project, "landing");

    let link: RunnerLink;
    try {
      link = await projectRunnerLink(
        { db: this.db, registry: this.deps.registry },
        project,
        userId,
      );
    } catch (error) {
      await this.failed(entry, "runner", message(error), by);
      return;
    }

    // The checks first, on the branch as it stands: a branch that is already broken should not
    // move the base at all, and rebasing it first would only tell us about the merge.
    const checks = MergeQueueService.checkCommand(project);
    const worktree = checks ? await this.worktreeOf(link, project, entry, userId) : null;
    if (checks && worktree) {
      try {
        const raw = await runnerCall(link, "exec", {
          workspace_id: entry.workspaceId,
          user_id: userId,
          command: checks.command,
          cwd: worktree,
          timeout: this.deps.queueCheckTimeoutMs ?? CHECK_TIMEOUT_MS,
        });
        const result = execResultSchema.parse(raw);
        if (result.exitCode !== 0) {
          await updateEntry(this.db, entry.id, {
            checks: {
              command: checks.command,
              exitCode: result.exitCode,
              output: tail(`${result.stdout}\n${result.stderr}`),
            },
          });
          await this.failed(
            entry,
            "checks",
            result.timedOut
              ? `\`${checks.command}\` ran out of time`
              : `\`${checks.command}\` exited ${result.exitCode}\n\n${tail(result.stderr || result.stdout)}`,
            by,
          );
          return;
        }
        await updateEntry(this.db, entry.id, {
          checks: { command: checks.command, exitCode: 0, output: tail(result.stdout) },
        });
      } catch (error) {
        await this.failed(entry, "runner", message(error), by);
        return;
      }
    }

    try {
      const raw = await runnerCall(link, "git.merge", {
        workspace_id: entry.workspaceId,
        user_id: userId,
        project: project.id,
        branch: entry.branch,
        into: entry.base,
        rebase: true,
      });
      const result = gitMergeResultSchema.parse(raw);
      if (!result.merged) {
        await this.failed(
          entry,
          result.conflict ? "conflict" : "runner",
          result.reason ?? "it would not land",
          by,
        );
        return;
      }
      await this.landed(entry, project, result.head ?? "", userId, by);
    } catch (error) {
      await this.failed(entry, "runner", message(error), by);
    }
  }

  /**
   * The directory the checks run in: the branch's own worktree. `worktree.create` hands back
   * where a branch already is rather than making a second one, so this is a lookup that makes one
   * the first time. Null when the project is not a repository, which is also when there is
   * nothing to land.
   */
  private async worktreeOf(
    link: RunnerLink,
    project: Project,
    entry: MergeQueueEntry,
    userId: string,
  ): Promise<string | null> {
    try {
      const raw = await runnerCall(link, "worktree.create", {
        workspace_id: entry.workspaceId,
        user_id: userId,
        project: project.id,
        branch: entry.branch,
        base: entry.base,
      });
      return worktreeCreateResultSchema.parse(raw).path;
    } catch (error) {
      this.deps.log.warn(
        { err: error, entryId: entry.id, branch: entry.branch },
        "no worktree for this branch; its checks are skipped",
      );
      return null;
    }
  }

  private async landed(
    entry: MergeQueueEntry,
    project: Project,
    head: string,
    userId: string,
    by: ActorContext,
  ): Promise<void> {
    const done = await updateEntry(this.db, entry.id, {
      state: "landed",
      head,
      finishedAt: new Date(),
      failure: null,
      detail: null,
    });
    await this.deps.bus.publish(
      "merge.landed",
      {
        workspaceId: entry.workspaceId,
        projectId: entry.projectId,
        entryId: entry.id,
        branch: entry.branch,
        head,
      },
      by,
    );
    await this.card(done ?? entry, project);
    // What landed is done being worked on: the item goes to review with nobody to review the
    // branch itself any more (spec §4's states; the person still says `done`).
    if (entry.workItemId) {
      const item = await getWorkItem(this.db, entry.workItemId);
      if (item && item.state !== "done" && item.state !== "cancelled") {
        await updateWorkItem(this.db, item.id, { state: "in_review" });
      }
    }
    void userId;
  }

  /**
   * A branch that did not land, and the agent that wrote it asked to fix it (spec §5.7 "ask the
   * agent to resolve"). The turn goes to the session that produced the branch, if it is still
   * open; otherwise the card is what somebody reads.
   */
  private async failed(
    entry: MergeQueueEntry,
    failure: MergeFailure,
    detail: string,
    by: ActorContext,
  ): Promise<void> {
    const done = await updateEntry(this.db, entry.id, {
      state: "failed",
      failure,
      detail: tail(detail),
      finishedAt: new Date(),
    });
    await this.deps.bus.publish(
      "merge.failed",
      {
        workspaceId: entry.workspaceId,
        projectId: entry.projectId,
        entryId: entry.id,
        branch: entry.branch,
        failure,
      },
      by,
    );
    const project = await findProject(this.db, entry.workspaceId, entry.projectId);
    if (project) await this.card(done ?? entry, project);
    if (entry.workItemId) {
      const item = await getWorkItem(this.db, entry.workItemId);
      if (item && item.state !== "done" && item.state !== "cancelled") {
        await updateWorkItem(this.db, item.id, { state: "needs_you" });
      }
    }
    await this.askAgent(done ?? entry, failure, detail);
  }

  private async askAgent(
    entry: MergeQueueEntry,
    failure: MergeFailure,
    detail: string,
  ): Promise<void> {
    if (!entry.sessionId) return;
    const session = await getSession(this.db, entry.sessionId);
    if (!session || session.status === "ended") return;
    const ask =
      failure === "conflict"
        ? `Your branch \`${entry.branch}\` will not rebase onto \`${entry.base}\`. Resolve the conflict and commit, and it goes back in the queue.\n\n${detail}`
        : `The project's checks failed on \`${entry.branch}\`, so it did not land. Fix what broke and commit.\n\n${detail}`;
    try {
      await this.deps.sessions.sendTurn(
        session,
        session.userId,
        { text: ask },
        { by: { actor: { type: "system" }, meta: {} } },
      );
    } catch (error) {
      this.deps.log.warn(
        { err: error, sessionId: entry.sessionId, entryId: entry.id },
        "the agent could not be asked to fix its branch",
      );
    }
  }

  /**
   * One card per entry, in the work item's thread, rewritten in place as it moves — the same
   * `updateMessageBlocks` path a streaming reply uses, so a thread reads as one queue.
   */
  private async card(
    entry: MergeQueueEntry,
    project: Project,
    state: MergeQueueEntry["state"] = entry.state,
  ): Promise<void> {
    if (!entry.threadRootId) return;
    const item = entry.workItemId ? await getWorkItem(this.db, entry.workItemId) : null;
    const block: MessageBlock = {
      type: "queue_card",
      branch: entry.branch,
      base: entry.base,
      state,
      position: entry.position,
      ...(item ? { identifier: identifierOf(project.key, item.number) } : {}),
      ...(entry.failure ? { failure: entry.failure } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.head ? { head: entry.head } : {}),
      ...(entry.checks?.command ? { checks: entry.checks.command } : {}),
    };

    const { getMessage } = await import("../repos/messages.ts");
    if (entry.cardMessageId) {
      const card = await getMessage(this.db, entry.cardMessageId);
      // No edit history on a card nobody wrote: the queue is rewriting its own status line.
      if (card) {
        await updateMessageBlocks(this.db, card, [block], {
          type: "system",
          id: entry.id,
          history: false,
        });
      }
      return;
    }
    const root = await getMessage(this.db, entry.threadRootId);
    if (!root) return;
    const message = await insertMessage(this.db, {
      workspaceId: entry.workspaceId,
      channelId: root.channelId,
      authorType: "system",
      authorId: entry.requestedBy ?? entry.id,
      blocks: [block],
      threadRootId: entry.threadRootId,
    });
    await updateEntry(this.db, entry.id, { cardMessageId: message.id });
  }
}

function message(error: unknown): string {
  if (error instanceof PerchError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Enough of a command's output for a card and a turn, from the end where the failure is. */
function tail(text: string, max = 4_000): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}
