/**
 * budgets (task 4.2): the ceiling a workspace sets for itself, for a person, or for a bot.
 */
import type { Budget, BudgetPeriod, BudgetSubject, Db } from "@perch/db";
import { schema } from "@perch/db";
import { and, asc, eq } from "drizzle-orm";

const { budgets } = schema;

export async function setBudget(
  db: Db,
  input: {
    workspaceId: string;
    subjectType: BudgetSubject;
    subjectId: string;
    limitUsd: number;
    period: BudgetPeriod;
    warnAt: number;
  },
): Promise<Budget> {
  const values = {
    workspaceId: input.workspaceId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    limitUsd: input.limitUsd.toFixed(6),
    period: input.period,
    warnAt: input.warnAt.toFixed(3),
  };
  const [row] = await db
    .insert(budgets)
    .values(values)
    .onConflictDoUpdate({
      target: [budgets.workspaceId, budgets.subjectType, budgets.subjectId],
      set: {
        limitUsd: values.limitUsd,
        period: values.period,
        warnAt: values.warnAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("the budget was not written");
  return row;
}

export async function listBudgets(db: Db, workspaceId: string): Promise<Budget[]> {
  return db
    .select()
    .from(budgets)
    .where(eq(budgets.workspaceId, workspaceId))
    .orderBy(asc(budgets.subjectType), asc(budgets.createdAt));
}

/** The budget for one subject, or null. A workspace's own has no subject id. */
export async function budgetFor(
  db: Db,
  workspaceId: string,
  subject: { type: BudgetSubject; id: string },
): Promise<Budget | null> {
  const [row] = await db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.workspaceId, workspaceId),
        eq(budgets.subjectType, subject.type),
        eq(budgets.subjectId, subject.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deleteBudget(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(budgets)
    .where(and(eq(budgets.workspaceId, workspaceId), eq(budgets.id, id)))
    .returning();
  return rows.length > 0;
}
