/**
 * Cycles, modules, and the views people save (spec §4 "Work (Plane)": "cycles with burndown and
 * agent throughput; modules; saved views with filters and display properties"; task 3.26).
 *
 * A work item says what is happening. This is everything around it: which fortnight it belongs to,
 * which part of the product it is, and the way one person likes to look at the pile. None of it
 * moves an item by itself — closing a cycle carries the unfinished work forward rather than
 * declaring it done, because a date passing is not a thing being finished.
 */
import type { Bus } from "@perch/bus";
import type {
  Cycle,
  Db,
  DbHandle,
  Module,
  SavedView,
  ViewDisplay,
  ViewFilters,
  ViewLayout,
  WorkItem,
  WorkItemRelation,
  WorkRelationKind,
} from "@perch/db";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  childItems,
  deleteCycle,
  deleteModule,
  deleteRelation,
  deleteView,
  getCycle,
  getModule,
  getView,
  insertCycle,
  insertModule,
  insertRelation,
  insertView,
  listCycles,
  listModules,
  listRelations,
  listViews,
  relatedItems,
  updateCycle,
  updateModule,
  updateView,
} from "../repos/planning.ts";
import { sessionsForWorkItem } from "../repos/sessions.ts";
import { carryOver, getWorkItem, itemsInCycle } from "../repos/work.ts";

export type PlanningDeps = { db: DbHandle; bus: Bus; log: Logger };

/** One day of a cycle: what was left at the end of it, and what the straight line would have said. */
export type BurndownDay = {
  /** The day, as `YYYY-MM-DD` in UTC. */
  date: string;
  /** Items in the cycle that existed by then and were not finished. */
  remaining: number;
  /** The same in estimate points, for a team that estimates. */
  remainingEstimate: number;
  /** Finished on that day. */
  done: number;
  /** Where a cycle that burned down evenly would have been. */
  ideal: number;
};

/** Who finished the work, per day (spec §4 "agent throughput"). */
export type ThroughputDay = { date: string; byAgent: number; byPerson: number };

export type Burndown = {
  cycleId: string;
  scope: number;
  scopeEstimate: number;
  done: number;
  days: BurndownDay[];
  throughput: ThroughputDay[];
};

/** A relation with the item on its other end, which is what a panel draws. */
export type RelationView = { relation: WorkItemRelation; item: WorkItem | null };

const DAY_MS = 86_400_000;
/** A burndown is a chart, and a chart nobody can read is not worth the query. */
const MAX_DAYS = 90;

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function endOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999Z`);
}

function points(item: WorkItem): number {
  const value = Number(item.estimate ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export class PlanningService {
  constructor(private readonly deps: PlanningDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  /* ---------------------------------------------------------------- cycles */

  cycles(projectId: string): Promise<Cycle[]> {
    return listCycles(this.db, projectId);
  }

  cycle(id: string): Promise<Cycle | null> {
    return getCycle(this.db, id);
  }

  async createCycle(input: {
    workspaceId: string;
    projectId: string;
    name: string;
    startsAt?: Date | null;
    endsAt?: Date | null;
    by: ActorContext;
  }): Promise<Cycle> {
    if (input.startsAt && input.endsAt && input.endsAt < input.startsAt) {
      throw PerchError.validation("a cycle cannot end before it starts");
    }
    const cycle = await insertCycle(this.db, {
      projectId: input.projectId,
      name: input.name,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    });
    await this.deps.bus.publish(
      "cycle.created",
      { workspaceId: input.workspaceId, projectId: input.projectId, cycleId: cycle.id },
      { ...input.by, topics: [`ws:${input.workspaceId}`] },
    );
    return cycle;
  }

  async patchCycle(
    workspaceId: string,
    cycle: Cycle,
    patch: {
      name?: string;
      startsAt?: Date | null;
      endsAt?: Date | null;
      status?: Cycle["status"];
    },
    by: ActorContext,
  ): Promise<Cycle> {
    const startsAt = patch.startsAt === undefined ? cycle.startsAt : patch.startsAt;
    const endsAt = patch.endsAt === undefined ? cycle.endsAt : patch.endsAt;
    if (startsAt && endsAt && endsAt < startsAt) {
      throw PerchError.validation("a cycle cannot end before it starts");
    }
    // Closing is its own door, because it moves work: `close()`, not a status you can type.
    if (patch.status === "closed" && cycle.status !== "closed") {
      throw PerchError.validation("close a cycle with POST /api/cycles/{id}/close");
    }
    const row = await updateCycle(this.db, cycle.id, patch);
    if (!row) throw PerchError.notFound("cycle");
    await this.deps.bus.publish(
      "cycle.updated",
      { workspaceId, projectId: row.projectId, cycleId: row.id, status: row.status },
      { ...by, topics: [`ws:${workspaceId}`] },
    );
    return row;
  }

  /**
   * Closing a cycle. Whatever is not finished goes to the next one if there is one, and back to no
   * cycle if there is not — never to `done`, because a fortnight ending is not work being done.
   */
  async closeCycle(
    workspaceId: string,
    cycle: Cycle,
    input: { into?: string | null; by: ActorContext },
  ): Promise<{ cycle: Cycle; carriedOver: number; burndown: Burndown }> {
    if (input.into) {
      const next = await getCycle(this.db, input.into);
      if (!next || next.projectId !== cycle.projectId) throw PerchError.notFound("cycle");
      if (next.id === cycle.id) throw PerchError.validation("a cycle cannot carry into itself");
    }
    const burndown = await this.burndown(cycle);
    const carried = await carryOver(this.db, cycle.id, input.into ?? null);
    const row = await updateCycle(this.db, cycle.id, { status: "closed" });
    if (!row) throw PerchError.notFound("cycle");
    await this.deps.bus.publish(
      "cycle.closed",
      {
        workspaceId,
        projectId: row.projectId,
        cycleId: row.id,
        carriedOver: carried,
      },
      { ...input.by, topics: [`ws:${workspaceId}`] },
    );
    return { cycle: row, carriedOver: carried, burndown };
  }

  async removeCycle(workspaceId: string, cycle: Cycle, by: ActorContext): Promise<void> {
    await deleteCycle(this.db, cycle.id);
    await this.deps.bus.publish(
      "cycle.updated",
      { workspaceId, projectId: cycle.projectId, cycleId: cycle.id, status: "deleted" },
      { ...by, topics: [`ws:${workspaceId}`] },
    );
  }

  /**
   * The burndown, counted from the items themselves rather than from a snapshot somebody took:
   * for every day of the cycle, what existed by then and had not been finished.
   */
  async burndown(cycle: Cycle): Promise<Burndown> {
    const items = await itemsInCycle(this.db, cycle.id);
    const first = items.reduce<Date | null>(
      (soonest, item) => (!soonest || item.createdAt < soonest ? item.createdAt : soonest),
      null,
    );
    const from = cycle.startsAt ?? first ?? new Date();
    const until = cycle.endsAt && cycle.endsAt < new Date() ? cycle.endsAt : new Date();
    const span = Math.max(0, Math.floor((until.getTime() - from.getTime()) / DAY_MS));
    const length = Math.min(span, MAX_DAYS);
    const scope = items.length;
    const scopeEstimate = items.reduce((sum, item) => sum + points(item), 0);

    const finished = (item: WorkItem): Date | null =>
      item.state === "done" || item.state === "cancelled"
        ? (item.completedAt ?? item.updatedAt)
        : null;

    const days: BurndownDay[] = [];
    const throughput: ThroughputDay[] = [];
    const agents = await this.whoDidIt(items);
    for (let at = 0; at <= length; at += 1) {
      const date = dayOf(new Date(from.getTime() + at * DAY_MS));
      const edge = endOfDay(date);
      let remaining = 0;
      let remainingEstimate = 0;
      let done = 0;
      let byAgent = 0;
      let byPerson = 0;
      for (const item of items) {
        if (item.createdAt > edge) continue;
        const at_ = finished(item);
        if (!at_ || at_ > edge) {
          remaining += 1;
          remainingEstimate += points(item);
          continue;
        }
        if (dayOf(at_) === date) {
          done += 1;
          if (agents.has(item.id)) byAgent += 1;
          else byPerson += 1;
        }
      }
      const ideal = length === 0 ? 0 : Math.max(0, scope - (scope * at) / length);
      days.push({
        date,
        remaining,
        remainingEstimate: Math.round(remainingEstimate * 100) / 100,
        done,
        ideal: Math.round(ideal * 100) / 100,
      });
      throughput.push({ date, byAgent, byPerson });
    }
    return {
      cycleId: cycle.id,
      scope,
      scopeEstimate: Math.round(scopeEstimate * 100) / 100,
      done: items.filter((item) => finished(item) !== null).length,
      days,
      throughput,
    };
  }

  /**
   * Which of these an agent did. A bot it was assigned to counts, and so does a session opened
   * from it — that is the whole difference this tracker is here to show.
   */
  private async whoDidIt(items: readonly WorkItem[]): Promise<Set<string>> {
    const agents = new Set<string>();
    for (const item of items) {
      if (item.assigneeType === "bot" || item.sessionId) {
        agents.add(item.id);
        continue;
      }
      const sessions = await sessionsForWorkItem(this.db, item.id);
      if (sessions.length > 0) agents.add(item.id);
    }
    return agents;
  }

  /* --------------------------------------------------------------- modules */

  modules(projectId: string): Promise<Module[]> {
    return listModules(this.db, projectId);
  }

  module(id: string): Promise<Module | null> {
    return getModule(this.db, id);
  }

  async createModule(input: {
    workspaceId: string;
    projectId: string;
    name: string;
    description?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
    by: ActorContext;
  }): Promise<Module> {
    const row = await insertModule(this.db, {
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    });
    await this.deps.bus.publish(
      "module.created",
      { workspaceId: input.workspaceId, projectId: input.projectId, moduleId: row.id },
      { ...input.by, topics: [`ws:${input.workspaceId}`] },
    );
    return row;
  }

  async patchModule(
    workspaceId: string,
    module: Module,
    patch: {
      name?: string;
      description?: string | null;
      startsAt?: Date | null;
      endsAt?: Date | null;
    },
    by: ActorContext,
  ): Promise<Module> {
    const row = await updateModule(this.db, module.id, patch);
    if (!row) throw PerchError.notFound("module");
    await this.deps.bus.publish(
      "module.updated",
      { workspaceId, projectId: row.projectId, moduleId: row.id },
      { ...by, topics: [`ws:${workspaceId}`] },
    );
    return row;
  }

  async removeModule(module: Module): Promise<void> {
    await deleteModule(this.db, module.id);
  }

  /* ----------------------------------------------------------------- views */

  views(workspaceId: string, userId: string, projectId?: string): Promise<SavedView[]> {
    return listViews(this.db, workspaceId, userId, projectId);
  }

  view(id: string): Promise<SavedView | null> {
    return getView(this.db, id);
  }

  /** Whether this person is allowed to see a view at all: theirs, or one somebody shared. */
  mayRead(view: SavedView, userId: string): boolean {
    return view.shared || view.ownerId === userId;
  }

  async createView(input: {
    workspaceId: string;
    projectId?: string | null;
    userId: string;
    name: string;
    layout: ViewLayout;
    filters: ViewFilters;
    display: ViewDisplay;
    shared: boolean;
    by: ActorContext;
  }): Promise<SavedView> {
    const row = await insertView(this.db, {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      ownerId: input.userId,
      name: input.name,
      layout: input.layout,
      filters: input.filters,
      display: input.display,
      shared: input.shared,
    });
    await this.deps.bus.publish(
      "view.saved",
      {
        workspaceId: input.workspaceId,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        viewId: row.id,
        layout: row.layout,
        shared: row.shared,
      },
      { ...input.by, topics: [`ws:${input.workspaceId}`] },
    );
    return row;
  }

  async patchView(
    view: SavedView,
    patch: {
      name?: string;
      layout?: ViewLayout;
      filters?: ViewFilters;
      display?: ViewDisplay;
      shared?: boolean;
    },
    by: ActorContext,
  ): Promise<SavedView> {
    const row = await updateView(this.db, view.id, patch);
    if (!row) throw PerchError.notFound("view");
    await this.deps.bus.publish(
      "view.saved",
      {
        workspaceId: row.workspaceId,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        viewId: row.id,
        layout: row.layout,
        shared: row.shared,
      },
      { ...by, topics: [`ws:${row.workspaceId}`] },
    );
    return row;
  }

  async removeView(view: SavedView, by: ActorContext): Promise<void> {
    await deleteView(this.db, view.id);
    await this.deps.bus.publish(
      "view.removed",
      { workspaceId: view.workspaceId, viewId: view.id },
      { ...by, topics: [`ws:${view.workspaceId}`] },
    );
  }

  /* ------------------------------------------------- relations and children */

  /** An item's relations, each with the item on the other end. */
  async relations(workItemId: string): Promise<RelationView[]> {
    const rows = await listRelations(this.db, workItemId);
    const others = await relatedItems(
      this.db,
      rows.map((row) => row.relatedId),
    );
    const byId = new Map(others.map((item) => [item.id, item]));
    return rows.map((relation) => ({ relation, item: byId.get(relation.relatedId) ?? null }));
  }

  children(parentId: string): Promise<WorkItem[]> {
    return childItems(this.db, parentId);
  }

  async relate(input: {
    workspaceId: string;
    item: WorkItem;
    relatedId: string;
    kind: WorkRelationKind;
    by: ActorContext;
  }): Promise<WorkItemRelation> {
    if (input.relatedId === input.item.id) {
      throw PerchError.validation("an item cannot be related to itself");
    }
    const other = await getWorkItem(this.db, input.relatedId);
    // Across projects is a different workspace's business; across workspaces is nobody's.
    if (!other || other.workspaceId !== input.item.workspaceId) throw PerchError.notFound("item");
    const relation = await insertRelation(this.db, {
      workItemId: input.item.id,
      relatedId: other.id,
      kind: input.kind,
    });
    await this.deps.bus.publish(
      "work_item.updated",
      {
        workspaceId: input.workspaceId,
        projectId: input.item.projectId,
        workItemId: input.item.id,
        changes: ["relations"],
      },
      { ...input.by, topics: [`ws:${input.workspaceId}`] },
    );
    return relation;
  }

  async unrelate(input: {
    workspaceId: string;
    item: WorkItem;
    relatedId: string;
    kind: WorkRelationKind;
    by: ActorContext;
  }): Promise<boolean> {
    const gone = await deleteRelation(this.db, {
      workItemId: input.item.id,
      relatedId: input.relatedId,
      kind: input.kind,
    });
    if (gone) {
      await this.deps.bus.publish(
        "work_item.updated",
        {
          workspaceId: input.workspaceId,
          projectId: input.item.projectId,
          workItemId: input.item.id,
          changes: ["relations"],
        },
        { ...input.by, topics: [`ws:${input.workspaceId}`] },
      );
    }
    return gone;
  }
}
