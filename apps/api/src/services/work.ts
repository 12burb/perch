/**
 * Work items and the board (spec §4 "Work (Plane)", §6, §7.1; task 3.13).
 *
 * The board's two interesting columns are `running` and `needs_you`, and neither is somebody's
 * opinion: a session opened from an item drives them. That is the whole idea — a tracker whose
 * states move because the work moved, not because somebody remembered to drag a card.
 *
 * So the state machine lives here rather than in a handler: `start()` puts an item in `running`
 * and points it at the session, the bus puts it in `needs_you` when the engine asks a question
 * and back into `running` when it is answered, and a session that ends takes the item to
 * `in_review` — with the pull request on it if there is one — rather than to `done`, because
 * nobody but a person says a thing is finished.
 */
import type { Bus } from "@perch/bus";
import type {
  CodingSession,
  Db,
  DbHandle,
  Project,
  WorkAssignee,
  WorkItem,
  WorkItemState,
  WorkItemType,
} from "@perch/db";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { getCycle, getModule } from "../repos/planning.ts";
import { findProject, findProjectByKey } from "../repos/projects.ts";
import { getSession, sessionsForWorkItem } from "../repos/sessions.ts";
import {
  type BoardOptions,
  claimWorkItem,
  getWorkItem,
  insertWorkItem,
  listIntake,
  listWorkItems,
  updateWorkItem,
  workItemByNumber,
  workItemForSession,
} from "../repos/work.ts";
import type { SessionService } from "./sessions.ts";

export type WorkDeps = {
  db: DbHandle;
  bus: Bus;
  log: Logger;
  sessions: SessionService;
};

export type CreateWorkItem = {
  project: Project;
  title: string;
  userId: string;
  type?: WorkItemType;
  description?: string;
  state?: WorkItemState;
  priority?: number;
  assignee?: { type: WorkAssignee; id: string } | null;
  labels?: string[];
  threadRootId?: string;
  source?: "manual" | "message" | "bot" | "intake";
  by: ActorContext;
};

export type PatchWorkItem = {
  title?: string;
  description?: string;
  /** §4's Tiptap document, kept beside the text so search and a plain client still work. */
  descriptionDoc?: unknown;
  type?: WorkItemType;
  state?: WorkItemState;
  priority?: number;
  assignee?: { type: WorkAssignee; id: string } | null;
  labels?: string[];
  prUrl?: string | null;
  /** Where it is planned (task 3.26): a cycle, a module, a parent, an estimate, a date. */
  cycleId?: string | null;
  moduleId?: string | null;
  parentId?: string | null;
  estimate?: number | null;
  dueAt?: Date | null;
};

/**
 * A session's status, as a place on the board. `idle` is not here: a session between turns has
 * not moved, and saying so would drag an item somebody has already reviewed back to `running`.
 */
const FOLLOWS: Record<string, WorkItemState | undefined> = {
  running: "running",
  needs_you: "needs_you",
  error: "needs_you",
  ended: "in_review",
};

/** `KEY-123`: the project's key and the item's number (spec §7.8). */
export function identifierOf(projectKey: string, number: number): string {
  return `${projectKey.toUpperCase()}-${number}`;
}

/**
 * The branch, and the worktree named for it, that this item's agent works in (task 3.14).
 * `perch/key-123` — lowercase because git refs are case-sensitive and `KEY-123` and `key-123`
 * being two branches on a case-insensitive filesystem is a bad afternoon.
 */
export function branchOf(projectKey: string, number: number): string {
  return `perch/${projectKey.toLowerCase()}-${number}`;
}

/** A session with a round going: running, or stopped on a permission it is waiting to hear about. */
function working(sessions: SessionService, session: CodingSession, ended?: string): boolean {
  // The session whose end is being handled has said so on the bus already; its round is on its
  // way out of the map, and waiting for that would wait on nothing.
  if (session.id === ended) return false;
  return (
    sessions.running(session.id) || session.status === "running" || session.status === "needs_you"
  );
}

/**
 * Gives worktrees back without pulling one out from under a round (A-sm-24). `rows` are sessions
 * that worked in them, fresh from the database; a worktree is a branch, and sessions can share one
 * (every session of a work item works on the item's branch). A worktree nobody is working in goes
 * now. One with a round still going is not touched: that round is cancelled, and the worktree goes
 * when the last round in it reaches the bus as `ended` or `error` — the board's and the races'
 * `session.status` subscribers call this again then, naming the session that just `ended`. (Every
 * session opened for an item or a race is unattended, so a cancelled round settles to `ended`.)
 */
export async function releaseWorktrees(
  sessions: SessionService,
  rows: CodingSession[],
  log: Logger,
  options: { ended?: string } = {},
): Promise<void> {
  const byWorktree = new Map<string, CodingSession[]>();
  for (const row of rows) {
    if (!row.worktree) continue;
    byWorktree.set(row.worktree, [...(byWorktree.get(row.worktree) ?? []), row]);
  }
  for (const group of byWorktree.values()) {
    const going = group.filter((one) => working(sessions, one, options.ended));
    if (going.length > 0) {
      for (const one of going) {
        await sessions.cancel(one).catch((error: unknown) => {
          log.warn({ err: error, sessionId: one.id }, "a round could not be cancelled");
        });
      }
      continue;
    }
    const [first] = group;
    if (first) await sessions.dropWorktree(first, first.userId);
  }
}

/** What a work item cost, and where its time went (spec §5.7; task 3.22). */
export type WorkItemCost = {
  costUsd: number;
  /** Wall clock from the item being made to its last session ending, or to now. */
  elapsedMs: number;
  /** The part of that a session was actually running; sessions overlap, so it can exceed it. */
  workingMs: number;
  turns: number;
  sessions: {
    id: string;
    engine: string;
    status: string;
    costUsd: number;
    turns: number;
    elapsedMs: number;
  }[];
};

export class WorkService {
  /** Items whose session is being started in this process, claimed before the first await. */
  private readonly starting = new Set<string>();

  constructor(private readonly deps: WorkDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  async create(input: CreateWorkItem): Promise<WorkItem> {
    const title = input.title.trim();
    if (!title) throw PerchError.validation("a work item needs a title");
    const item = await insertWorkItem(this.db, {
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      title,
      type: input.type ?? "task",
      description: { text: input.description ?? "" },
      state: input.state ?? "backlog",
      priority: input.priority ?? 0,
      labels: input.labels ?? [],
      source: input.source ?? "manual",
      // Anything that arrived rather than being typed waits in the triage queue (task 3.26).
      ...(input.source === "intake" ? { intakeStatus: "pending" } : {}),
      createdBy: input.userId,
      ...(input.assignee
        ? { assigneeType: input.assignee.type, assigneeId: input.assignee.id }
        : {}),
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
    });
    await this.deps.bus.publish(
      "work_item.created",
      {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
      },
      input.by,
    );
    if (item.assigneeType && item.assigneeId) await this.announceAssignee(item, input.by);
    return item;
  }

  /**
   * One patch, one round of events: `work_item.updated` always, and the narrower
   * `state_changed` and `assigned` on top when those are what moved, because the Bot API and the
   * board want different things out of the same edit (spec §7.7).
   */
  async update(item: WorkItem, patch: PatchWorkItem, by: ActorContext): Promise<WorkItem> {
    const changes: string[] = [];
    const values: Parameters<typeof updateWorkItem>[2] = {};
    if (patch.title !== undefined && patch.title.trim() !== item.title) {
      const title = patch.title.trim();
      if (!title) throw PerchError.validation("a work item needs a title");
      values.title = title;
      changes.push("title");
    }
    if (patch.description !== undefined && patch.description !== item.description.text) {
      values.description = { ...item.description, text: patch.description };
      changes.push("description");
    }
    if (patch.descriptionDoc !== undefined) {
      // The rich document and the plain text are one column: a description edited in the editor
      // and one typed into a bot's `update` are the same field, and the last writer wins.
      values.description = {
        ...(values.description ?? item.description),
        ...(patch.descriptionDoc === null ? {} : { doc: patch.descriptionDoc }),
      };
      if (patch.descriptionDoc === null && values.description.doc !== undefined) {
        const { doc: _dropped, ...rest } = values.description;
        values.description = rest;
      }
      if (!changes.includes("description")) changes.push("description");
    }
    if (patch.type !== undefined && patch.type !== item.type) {
      values.type = patch.type;
      changes.push("type");
    }
    if (patch.priority !== undefined && patch.priority !== item.priority) {
      if (patch.priority < 0 || patch.priority > 4) {
        throw PerchError.validation("priority is 0 (none) to 4 (low)");
      }
      values.priority = patch.priority;
      changes.push("priority");
    }
    if (patch.labels !== undefined) {
      values.labels = patch.labels;
      changes.push("labels");
    }
    if (patch.prUrl !== undefined && patch.prUrl !== item.prUrl) {
      values.prUrl = patch.prUrl;
      changes.push("pr_url");
    }
    if (patch.cycleId !== undefined && patch.cycleId !== item.cycleId) {
      // The project's own, like a parent (spec §9.1 scoping): a cycle from elsewhere is not there.
      if (patch.cycleId) {
        const cycle = await getCycle(this.db, patch.cycleId);
        if (!cycle || cycle.projectId !== item.projectId) throw PerchError.notFound("cycle");
      }
      values.cycleId = patch.cycleId;
      changes.push("cycle");
    }
    if (patch.moduleId !== undefined && patch.moduleId !== item.moduleId) {
      if (patch.moduleId) {
        const module = await getModule(this.db, patch.moduleId);
        if (!module || module.projectId !== item.projectId) throw PerchError.notFound("module");
      }
      values.moduleId = patch.moduleId;
      changes.push("module");
    }
    if (patch.parentId !== undefined && patch.parentId !== item.parentId) {
      if (patch.parentId === item.id)
        throw PerchError.validation("an item cannot be its own parent");
      if (patch.parentId) {
        const parent = await getWorkItem(this.db, patch.parentId);
        if (!parent || parent.projectId !== item.projectId) throw PerchError.notFound("parent");
        // One level, the way §4 draws it: sub-items of sub-items is a tree nobody can read on a
        // phone, and an epic is the thing that holds the rest.
        if (parent.parentId) throw PerchError.validation("a sub-item cannot have sub-items");
      }
      values.parentId = patch.parentId;
      changes.push("parent");
    }
    if (patch.estimate !== undefined) {
      const was = item.estimate === null ? null : Number(item.estimate);
      if (patch.estimate !== was) {
        if (patch.estimate !== null && (patch.estimate < 0 || patch.estimate > 1000)) {
          throw PerchError.validation("an estimate is between 0 and 1000");
        }
        values.estimate = patch.estimate === null ? null : String(patch.estimate);
        changes.push("estimate");
      }
    }
    if (patch.dueAt !== undefined && patch.dueAt?.getTime() !== item.dueAt?.getTime()) {
      values.dueAt = patch.dueAt;
      changes.push("due");
    }
    const movedTo = patch.state !== undefined && patch.state !== item.state ? patch.state : null;
    if (movedTo) {
      values.state = movedTo;
      changes.push("state");
      // When it was finished, so a burndown can ask what was left on Tuesday (task 3.26).
      const over = movedTo === "done" || movedTo === "cancelled";
      values.completedAt = over ? (item.completedAt ?? new Date()) : null;
    }
    const reassigned =
      patch.assignee !== undefined &&
      (patch.assignee?.type !== item.assigneeType || patch.assignee?.id !== item.assigneeId);
    if (reassigned) {
      values.assigneeType = patch.assignee?.type ?? null;
      values.assigneeId = patch.assignee?.id ?? null;
      changes.push("assignee");
    }
    if (changes.length === 0) return item;

    const updated = await updateWorkItem(this.db, item.id, values);
    if (!updated) throw PerchError.notFound("work item");
    await this.deps.bus.publish(
      "work_item.updated",
      {
        workspaceId: updated.workspaceId,
        projectId: updated.projectId,
        workItemId: updated.id,
        changes,
      },
      by,
    );
    if (movedTo) {
      await this.deps.bus.publish(
        "work_item.state_changed",
        {
          workspaceId: updated.workspaceId,
          projectId: updated.projectId,
          workItemId: updated.id,
          state: movedTo,
          previousState: item.state,
        },
        by,
      );
    }
    if (reassigned) await this.announceAssignee(updated, by);
    // Closed means nobody is working in it: the worktree goes back (task 3.14) — once the agent
    // still in it, if there is one, has been stopped (A-sm-24). The branch and its commits stay: a
    // checkout is a place to work, not the work.
    if (movedTo === "done" || movedTo === "cancelled") await this.releaseWorktrees(updated);
    return updated;
  }

  /** What is waiting to be triaged (spec §4 "Intake triage queue"; task 3.26). */
  intake(projectId: string): Promise<WorkItem[]> {
    return listIntake(this.db, projectId);
  }

  /**
   * Triage (spec §4 "accept/decline/convert"). Accepting is what turns something that arrived into
   * work this team has: it can change the type and land it in a cycle on the way in, which is what
   * "convert" means. Declining cancels it and says so — the row stays, because what was asked for
   * and turned down is worth being able to find.
   */
  async triage(
    item: WorkItem,
    verdict: { decision: "accept" | "decline"; type?: WorkItemType; cycleId?: string | null },
    by: ActorContext,
  ): Promise<WorkItem> {
    if (item.intakeStatus !== "pending") {
      throw PerchError.validation("that item is not waiting in intake");
    }
    const accepted = verdict.decision === "accept";
    const updated = await updateWorkItem(this.db, item.id, {
      intakeStatus: accepted ? "accepted" : "declined",
      ...(accepted ? {} : { state: "cancelled", completedAt: new Date() }),
      ...(verdict.type ? { type: verdict.type } : {}),
      ...(verdict.cycleId === undefined ? {} : { cycleId: verdict.cycleId }),
    });
    if (!updated) throw PerchError.notFound("work item");
    await this.deps.bus.publish(
      "work_item.updated",
      {
        workspaceId: updated.workspaceId,
        projectId: updated.projectId,
        workItemId: updated.id,
        changes: ["intake"],
      },
      by,
    );
    if (!accepted) {
      await this.deps.bus.publish(
        "work_item.state_changed",
        {
          workspaceId: updated.workspaceId,
          projectId: updated.projectId,
          workItemId: updated.id,
          state: "cancelled",
          previousState: item.state,
        },
        by,
      );
    }
    return updated;
  }

  /** The directories this item's sessions worked in, given back to the runner (task 3.14). */
  private async releaseWorktrees(item: WorkItem, ended?: string): Promise<void> {
    await releaseWorktrees(
      this.deps.sessions,
      await sessionsForWorkItem(this.db, item.id),
      this.deps.log,
      ended ? { ended } : {},
    );
  }

  /**
   * A session of a closed item has finished its round: the worktree it was cancelled out of can go
   * now, unless another round is still in it (A-sm-24).
   */
  private async releaseIfClosed(sessionId: string): Promise<void> {
    try {
      const session = await getSession(this.db, sessionId);
      if (!session?.worktree || !session.workItemId) return;
      const item = await getWorkItem(this.db, session.workItemId);
      if (item?.state !== "done" && item?.state !== "cancelled") return;
      await this.releaseWorktrees(item, session.id);
    } catch (error) {
      this.deps.log.error({ err: error, sessionId }, "a closed item's worktree was not released");
    }
  }

  /**
   * Hand the item to an agent (spec §7.1 `POST /api/work-items/{id}/start-session`). The item goes
   * to `running` and points at the session, so the board shows what is happening without anybody
   * saying so.
   */
  async startSession(
    item: WorkItem,
    input: { userId: string; engine?: string; prompt?: string; by: ActorContext },
  ): Promise<{ item: WorkItem; sessionId: string }> {
    // One agent per item (X-data-18). A second start while the first is still being set up — a
    // double click, the board and a bot at once — is refused here, before anything is awaited;
    // the conditional update below settles it between processes.
    if (item.sessionId || this.starting.has(item.id)) {
      throw PerchError.conflict("this item already has a session");
    }
    this.starting.add(item.id);
    try {
      return await this.startClaimed(item, input);
    } finally {
      this.starting.delete(item.id);
    }
  }

  private async startClaimed(
    item: WorkItem,
    input: { userId: string; engine?: string; prompt?: string; by: ActorContext },
  ): Promise<{ item: WorkItem; sessionId: string }> {
    const project = await this.projectOf(item);
    const open = {
      project,
      userId: input.userId,
      by: input.by,
      workItemId: item.id,
      title: `${identifierOf(project.key, item.number)} ${item.title}`,
      ...(input.engine ? { engine: input.engine } : {}),
    };
    // Its own checkout (task 3.14). Two items on one repository are two directories, so two
    // agents never see each other's half-finished edits — and the branch is already the one a
    // pull request wants. A project that is not a repository has no worktree to give; that is a
    // reason to work in the project directory, not a reason the item cannot be started.
    let session: Awaited<ReturnType<SessionService["create"]>>;
    try {
      session = await this.deps.sessions.create({
        ...open,
        worktree: branchOf(project.key, item.number),
      });
    } catch (error) {
      this.deps.log.warn(
        { err: error, workItemId: item.id, projectId: project.id },
        "no worktree for this item; the session works in the project directory",
      );
      session = await this.deps.sessions.create(open);
    }
    // The item is taken only if it still points at no session: the update is the claim, so a start
    // that loaded the item before another one finished cannot take it as well.
    const updated = await claimWorkItem(this.db, item.id, session.id);
    if (!updated) {
      // Another session got there first. This one never had a turn; it ends rather than idling,
      // and it shares the item's worktree, so nothing is dropped.
      await this.deps.sessions.settle(session);
      throw PerchError.conflict("this item already has a session");
    }
    await this.moved(updated, item.state, "running", input.by);
    // The first turn is what the agent was asked to do; the item's own words when nothing else.
    const prompt = input.prompt?.trim() || `${item.title}\n\n${item.description.text}`.trim();
    await this.deps.sessions.sendTurn(session, input.userId, { text: prompt }, { by: input.by });
    return { item: updated, sessionId: session.id };
  }

  board(projectId: string, options: BoardOptions = {}): Promise<WorkItem[]> {
    return listWorkItems(this.db, projectId, options);
  }

  item(id: string): Promise<WorkItem | null> {
    return getWorkItem(this.db, id);
  }

  /**
   * What it cost and where the time went (task 3.22). Everything here is already recorded — the
   * sessions' own cost and their own clocks — because a second ledger of what an item cost is a
   * second answer that can disagree with the first.
   */
  async cost(workItemId: string): Promise<WorkItemCost> {
    const item = await getWorkItem(this.db, workItemId);
    const sessions = await sessionsForWorkItem(this.db, workItemId);
    const rows = sessions.map((one) => ({
      id: one.id,
      engine: one.engine,
      status: one.status,
      costUsd: one.costUsd,
      turns: one.turns,
      elapsedMs: Math.max(0, (one.endedAt ?? new Date()).getTime() - one.startedAt.getTime()),
    }));
    // The item's own clock stops at its last session, when it has one: an item that is done is not
    // still spending time.
    const last = sessions
      .map((one) => one.endedAt?.getTime() ?? Date.now())
      .reduce((a, b) => Math.max(a, b), 0);
    const from = item?.createdAt.getTime() ?? Date.now();
    return {
      costUsd: rows.reduce((sum, one) => sum + one.costUsd, 0),
      elapsedMs: Math.max(0, (last || Date.now()) - from),
      // Sessions can overlap (a race runs several at once), so this is time spent rather than time
      // passed, and the two are different numbers on purpose.
      workingMs: rows.reduce((sum, one) => sum + one.elapsedMs, 0),
      turns: rows.reduce((sum, one) => sum + one.turns, 0),
      sessions: rows,
    };
  }

  /**
   * The item a person or an agent named as `KEY-123` (spec §7.8). The key belongs to a project, so
   * this looks in the workspaces the caller may act in and nowhere else.
   */
  async byIdentifier(
    workspaceIds: string[],
    projectKey: string,
    number: number,
  ): Promise<WorkItem | null> {
    for (const workspaceId of workspaceIds) {
      const project = await findProjectByKey(this.db, workspaceId, projectKey);
      if (!project) continue;
      const item = await workItemByNumber(this.db, project.id, number);
      if (item) return item;
    }
    return null;
  }

  /**
   * The board, moved by the work (spec §4 "states … Running, Needs you, In review"). A session's
   * own status is already the answer — `running`, `needs_you`, `ended` — so the board follows it
   * rather than keeping a second opinion about the same thing.
   *
   * `ended` lands in `in_review`, never `done`: an agent finishing is not a person agreeing.
   */
  start(): () => void {
    return this.deps.bus.subscribe("session.status", (event) => {
      const status = event.payload.status;
      // A round in a closed item's worktree has ended: that worktree can go back now (A-sm-24).
      if (status === "ended" || status === "error")
        void this.releaseIfClosed(event.payload.sessionId);
      const next = FOLLOWS[status];
      if (!next) return;
      void this.followSession(event.payload.sessionId, next, {
        clearSession: event.payload.status === "ended",
      });
    });
  }

  private async followSession(
    sessionId: string,
    state: WorkItemState,
    options: { clearSession?: boolean } = {},
  ): Promise<void> {
    try {
      const item = await workItemForSession(this.db, sessionId);
      if (!item) return;
      // Somebody who has already reviewed it, closed it or cancelled it has said more than the
      // session can: never drag a settled item back onto the board.
      if (item.state === "done" || item.state === "cancelled") return;
      if (item.state === state && !options.clearSession) return;
      const updated = await updateWorkItem(this.db, item.id, {
        state,
        ...(options.clearSession ? { sessionId: null } : {}),
      });
      if (!updated) return;
      await this.moved(updated, item.state, state, { actor: { type: "system" }, meta: {} });
    } catch (error) {
      this.deps.log.error({ err: error, sessionId }, "a work item could not follow its session");
    }
  }

  private async moved(
    item: WorkItem,
    from: WorkItemState,
    to: WorkItemState,
    by: ActorContext,
  ): Promise<void> {
    const payload = {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      workItemId: item.id,
    };
    await this.deps.bus.publish("work_item.updated", { ...payload, changes: ["state"] }, by);
    if (from !== to) {
      await this.deps.bus.publish(
        "work_item.state_changed",
        { ...payload, state: to, previousState: from },
        by,
      );
    }
  }

  private async announceAssignee(item: WorkItem, by: ActorContext): Promise<void> {
    await this.deps.bus.publish(
      "work_item.assigned",
      {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
        ...(item.assigneeType ? { assigneeType: item.assigneeType } : {}),
        ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      },
      by,
    );
  }

  /** The project a work item belongs to, for the identifier and for authorization. */
  async projectOf(item: WorkItem): Promise<Project> {
    const project = await findProject(this.db, item.workspaceId, item.projectId);
    if (!project) throw PerchError.notFound("project");
    return project;
  }
}

/** Everything a caller is shown about an item, identifier included. */
export function viewWorkItem(item: WorkItem, projectKey: string) {
  return {
    id: item.id,
    identifier: identifierOf(projectKey, item.number),
    number: item.number,
    project_id: item.projectId,
    type: item.type,
    title: item.title,
    description: item.description.text,
    state: item.state,
    priority: item.priority,
    assignee_type: item.assigneeType,
    assignee_id: item.assigneeId,
    labels: item.labels,
    /** §4's Tiptap document, when one has been written (task 3.26). */
    description_doc: item.description.doc ?? null,
    cycle_id: item.cycleId,
    module_id: item.moduleId,
    parent_id: item.parentId,
    estimate: item.estimate === null ? null : Number(item.estimate),
    due_at: item.dueAt?.toISOString() ?? null,
    intake_status: item.intakeStatus,
    completed_at: item.completedAt?.toISOString() ?? null,
    thread_root_id: item.threadRootId,
    session_id: item.sessionId,
    pr_url: item.prUrl,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}
