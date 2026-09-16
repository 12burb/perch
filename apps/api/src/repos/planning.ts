/**
 * What work is planned into: cycles, modules, the views people save, and the relations between
 * items (spec §6 `cycles`, `modules`, `saved_views`, `work_item_relations`; task 3.26).
 *
 * All four are per project except a view, which may be a workspace's — somebody's way of looking
 * at everything rather than at one repository.
 */
import type {
  Cycle,
  Db,
  Module,
  SavedView,
  ViewDisplay,
  ViewFilters,
  ViewLayout,
  WorkItem,
  WorkItemRelation,
  WorkRelationKind,
} from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

const { cycles, modules, savedViews, workItemRelations, workItems } = schema;

/* ------------------------------------------------------------------ cycles */

export async function insertCycle(
  db: Db,
  values: { projectId: string; name: string; startsAt?: Date | null; endsAt?: Date | null },
): Promise<Cycle> {
  const [row] = await db
    .insert(cycles)
    .values({
      projectId: values.projectId,
      name: values.name,
      startsAt: values.startsAt ?? null,
      endsAt: values.endsAt ?? null,
    })
    .returning();
  if (!row) throw new Error("the cycle was not written");
  return row;
}

export async function getCycle(db: Db, id: string): Promise<Cycle | null> {
  const [row] = await db.select().from(cycles).where(eq(cycles.id, id)).limit(1);
  return row ?? null;
}

/** A project's cycles, in the order they happen; one with no dates sits at the end. */
export async function listCycles(db: Db, projectId: string): Promise<Cycle[]> {
  return db
    .select()
    .from(cycles)
    .where(eq(cycles.projectId, projectId))
    .orderBy(sql`${cycles.startsAt} asc nulls last`, asc(cycles.name));
}

export async function updateCycle(
  db: Db,
  id: string,
  patch: Partial<Pick<Cycle, "name" | "startsAt" | "endsAt" | "status">>,
): Promise<Cycle | null> {
  const [row] = await db
    .update(cycles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(cycles.id, id))
    .returning();
  return row ?? null;
}

export async function deleteCycle(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(cycles).where(eq(cycles.id, id)).returning();
  return rows.length > 0;
}

/* ----------------------------------------------------------------- modules */

export async function insertModule(
  db: Db,
  values: {
    projectId: string;
    name: string;
    description?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
  },
): Promise<Module> {
  const [row] = await db
    .insert(modules)
    .values({
      projectId: values.projectId,
      name: values.name,
      description: values.description ?? null,
      startsAt: values.startsAt ?? null,
      endsAt: values.endsAt ?? null,
    })
    .returning();
  if (!row) throw new Error("the module was not written");
  return row;
}

export async function getModule(db: Db, id: string): Promise<Module | null> {
  const [row] = await db.select().from(modules).where(eq(modules.id, id)).limit(1);
  return row ?? null;
}

export async function listModules(db: Db, projectId: string): Promise<Module[]> {
  return db
    .select()
    .from(modules)
    .where(eq(modules.projectId, projectId))
    .orderBy(asc(modules.name));
}

export async function updateModule(
  db: Db,
  id: string,
  patch: Partial<Pick<Module, "name" | "description" | "startsAt" | "endsAt">>,
): Promise<Module | null> {
  const [row] = await db
    .update(modules)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(modules.id, id))
    .returning();
  return row ?? null;
}

export async function deleteModule(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(modules).where(eq(modules.id, id)).returning();
  return rows.length > 0;
}

/* ------------------------------------------------------------- saved views */

export async function insertView(
  db: Db,
  values: {
    workspaceId: string;
    projectId?: string | null;
    ownerId: string;
    name: string;
    layout: ViewLayout;
    filters: ViewFilters;
    display: ViewDisplay;
    shared: boolean;
  },
): Promise<SavedView> {
  const [row] = await db
    .insert(savedViews)
    .values({
      workspaceId: values.workspaceId,
      projectId: values.projectId ?? null,
      ownerId: values.ownerId,
      name: values.name,
      layout: values.layout,
      filters: values.filters,
      display: values.display,
      shared: values.shared,
    })
    .returning();
  if (!row) throw new Error("the view was not written");
  return row;
}

export async function getView(db: Db, id: string): Promise<SavedView | null> {
  const [row] = await db.select().from(savedViews).where(eq(savedViews.id, id)).limit(1);
  return row ?? null;
}

/**
 * The views this person can see here: their own, plus the shared ones. A view with no project is
 * the workspace's and shows up whichever project is open.
 */
export async function listViews(
  db: Db,
  workspaceId: string,
  userId: string,
  projectId?: string,
): Promise<SavedView[]> {
  const mine = or(eq(savedViews.ownerId, userId), eq(savedViews.shared, true));
  const where = projectId
    ? and(
        eq(savedViews.workspaceId, workspaceId),
        or(eq(savedViews.projectId, projectId), isNull(savedViews.projectId)),
        mine,
      )
    : and(eq(savedViews.workspaceId, workspaceId), mine);
  return db.select().from(savedViews).where(where).orderBy(asc(savedViews.name));
}

export async function updateView(
  db: Db,
  id: string,
  patch: Partial<Pick<SavedView, "name" | "layout" | "filters" | "display" | "shared">>,
): Promise<SavedView | null> {
  const [row] = await db
    .update(savedViews)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(savedViews.id, id))
    .returning();
  return row ?? null;
}

export async function deleteView(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(savedViews).where(eq(savedViews.id, id)).returning();
  return rows.length > 0;
}

/* --------------------------------------------------------------- relations */

/** The other end of a relation, as it is written down. */
export const OPPOSITE: Record<WorkRelationKind, WorkRelationKind> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  relates: "relates",
  duplicates: "duplicates",
};

/**
 * Both rows, in one statement: a relation is a fact about two items, and an item that is blocked
 * should say so without anybody having to remember which end it was entered from.
 */
export async function insertRelation(
  db: Db,
  values: { workItemId: string; relatedId: string; kind: WorkRelationKind },
): Promise<WorkItemRelation> {
  const [row] = await db
    .insert(workItemRelations)
    .values([
      { workItemId: values.workItemId, relatedId: values.relatedId, kind: values.kind },
      {
        workItemId: values.relatedId,
        relatedId: values.workItemId,
        kind: OPPOSITE[values.kind],
      },
    ])
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // Already there: a second Add of the same relation is not an error, it is nothing to do.
  const [existing] = await db
    .select()
    .from(workItemRelations)
    .where(
      and(
        eq(workItemRelations.workItemId, values.workItemId),
        eq(workItemRelations.relatedId, values.relatedId),
        eq(workItemRelations.kind, values.kind),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("the relation was not written");
  return existing;
}

export async function listRelations(db: Db, workItemId: string): Promise<WorkItemRelation[]> {
  return db
    .select()
    .from(workItemRelations)
    .where(eq(workItemRelations.workItemId, workItemId))
    .orderBy(asc(workItemRelations.createdAt));
}

/** Takes both ends away, for the same reason both were written. */
export async function deleteRelation(
  db: Db,
  values: { workItemId: string; relatedId: string; kind: WorkRelationKind },
): Promise<boolean> {
  const rows = await db
    .delete(workItemRelations)
    .where(
      or(
        and(
          eq(workItemRelations.workItemId, values.workItemId),
          eq(workItemRelations.relatedId, values.relatedId),
          eq(workItemRelations.kind, values.kind),
        ),
        and(
          eq(workItemRelations.workItemId, values.relatedId),
          eq(workItemRelations.relatedId, values.workItemId),
          eq(workItemRelations.kind, OPPOSITE[values.kind]),
        ),
      ),
    )
    .returning();
  return rows.length > 0;
}

/** The items on the other end, so a panel can show titles rather than ids. */
export async function relatedItems(db: Db, ids: readonly string[]): Promise<WorkItem[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(workItems)
    .where(inArray(workItems.id, [...ids]));
}

/** An item's sub-items (spec §4 "parent/sub-items"), in the order a person would read them. */
export async function childItems(db: Db, parentId: string): Promise<WorkItem[]> {
  return db
    .select()
    .from(workItems)
    .where(eq(workItems.parentId, parentId))
    .orderBy(asc(workItems.number));
}
