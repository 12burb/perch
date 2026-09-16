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
import { findProject, findProjectByKey } from "../repos/projects.ts";
import {
  type BoardOptions,
  getWorkItem,
  insertWorkItem,
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
  type?: WorkItemType;
  state?: WorkItemState;
  priority?: number;
  assignee?: { type: WorkAssignee; id: string } | null;
  labels?: string[];
  prUrl?: string | null;
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

export class WorkService {
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
    const movedTo = patch.state !== undefined && patch.state !== item.state ? patch.state : null;
    if (movedTo) {
      values.state = movedTo;
      changes.push("state");
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
    return updated;
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
    if (item.sessionId) throw PerchError.conflict("this item already has a session");
    const project = await this.projectOf(item);
    const session = await this.deps.sessions.create({
      project,
      userId: input.userId,
      by: input.by,
      workItemId: item.id,
      title: `${identifierOf(project.key, item.number)} ${item.title}`,
      ...(input.engine ? { engine: input.engine } : {}),
    });
    const updated = await updateWorkItem(this.db, item.id, {
      sessionId: session.id,
      state: "running",
    });
    if (!updated) throw PerchError.notFound("work item");
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
      const next = FOLLOWS[event.payload.status];
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
    thread_root_id: item.threadRootId,
    session_id: item.sessionId,
    pr_url: item.prUrl,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}
