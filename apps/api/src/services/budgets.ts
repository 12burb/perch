/**
 * Budgets and what has been spent against them (spec §10's Phase 4 line; task 4.2).
 *
 * A budget is a ceiling a workspace sets: for itself, for a person, or for a bot. It is counted
 * from `usage_events` — the same ledger the gateway writes and a bot run writes — so there is one
 * answer to "what has this cost" rather than one per feature.
 *
 * Two doors: a **warning** when the spend crosses the fraction the budget names, said once on the
 * bus, and a **stop** when it reaches the limit, which every spender checks before spending.
 */
import type { Bus } from "@perch/bus";
import type { Budget, BudgetPeriod, BudgetSubject, Db, DbHandle } from "@perch/db";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { budgetFor, deleteBudget, listBudgets, setBudget } from "../repos/budgets.ts";
import { spentBy, type UsageGroup, type UsageSlice, usageBy } from "../repos/virtual-keys.ts";

export type BudgetsDeps = { db: DbHandle; bus: Bus; log: Logger };

export type Subject = { type: BudgetSubject; id?: string | null };

/** Who a subject is, as a row's `subject_id`: a workspace's own budget is the workspace's. */
function idOf(workspaceId: string, subject: Subject): string {
  return subject.type === "workspace" ? workspaceId : (subject.id ?? "");
}

/** What a check answers with: whether to go on, and what is left. */
export type Verdict =
  | { ok: true; remainingUsd: number | null }
  | { ok: false; reason: string; subject: Subject; spentUsd: number; limitUsd: number };

const DAY_MS = 86_400_000;

function windowStart(period: BudgetPeriod, now: Date): Date | null {
  if (period === "day") return new Date(now.getTime() - DAY_MS);
  if (period === "month") return new Date(now.getTime() - 30 * DAY_MS);
  return null;
}

function nameOf(subject: Subject): string {
  return subject.type === "workspace" ? "this workspace" : `this ${subject.type}`;
}

export class BudgetsService {
  constructor(private readonly deps: BudgetsDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  list(workspaceId: string): Promise<Budget[]> {
    return listBudgets(this.db, workspaceId);
  }

  async set(input: {
    workspaceId: string;
    subjectType: BudgetSubject;
    subjectId?: string | null;
    limitUsd: number;
    period: BudgetPeriod;
    warnAt?: number;
  }): Promise<Budget> {
    if (input.subjectType !== "workspace" && !input.subjectId) {
      throw PerchError.validation(`a ${input.subjectType} budget needs a subject`);
    }
    const warnAt = input.warnAt ?? 0.8;
    if (warnAt < 0 || warnAt > 1) throw PerchError.validation("warn_at is a fraction of the limit");
    return await setBudget(this.db, {
      workspaceId: input.workspaceId,
      subjectType: input.subjectType,
      subjectId: idOf(input.workspaceId, { type: input.subjectType, id: input.subjectId }),
      limitUsd: input.limitUsd,
      period: input.period,
      warnAt,
    });
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    if (!(await deleteBudget(this.db, workspaceId, id))) throw PerchError.notFound("budget");
  }

  /** The ledger, added up the way somebody asked for (spec §7.1 `usage?from&to&group_by`). */
  usage(
    workspaceId: string,
    options: { group: UsageGroup; from?: Date; to?: Date },
  ): Promise<UsageSlice[]> {
    return usageBy(this.db, workspaceId, options.group, {
      ...(options.from ? { from: options.from } : {}),
      ...(options.to ? { to: options.to } : {}),
    });
  }

  /** What one subject has spent inside its own budget's window, and its ceiling. */
  async standing(
    workspaceId: string,
    subject: Subject,
    now = new Date(),
  ): Promise<{ budget: Budget | null; spentUsd: number; remainingUsd: number | null }> {
    const budget = await budgetFor(this.db, workspaceId, {
      type: subject.type,
      id: idOf(workspaceId, subject),
    });
    if (!budget) return { budget: null, spentUsd: 0, remainingUsd: null };
    const spentUsd = await spentBy(this.db, workspaceId, subject, windowStart(budget.period, now));
    const limitUsd = Number(budget.limitUsd);
    return { budget, spentUsd, remainingUsd: Math.round((limitUsd - spentUsd) * 1e6) / 1e6 };
  }

  /**
   * Whether these subjects may spend. Every one of them is checked, because a person inside their
   * own budget is still inside the workspace's — the tightest ceiling wins, and the first one that
   * is reached is the one said out loud.
   */
  async check(
    workspaceId: string,
    subjects: readonly Subject[],
    by: ActorContext,
    now = new Date(),
  ): Promise<Verdict> {
    let tightest: number | null = null;
    for (const subject of subjects) {
      const { budget, spentUsd, remainingUsd } = await this.standing(workspaceId, subject, now);
      if (!budget) continue;
      const limitUsd = Number(budget.limitUsd);
      if (spentUsd >= limitUsd) {
        await this.deps.bus.publish(
          "budget.exceeded",
          {
            workspaceId,
            subjectType: subject.type,
            subjectId: idOf(workspaceId, subject),
            spentUsd: Math.round(spentUsd * 1e6) / 1e6,
            limitUsd,
          },
          { ...by, topics: [`ws:${workspaceId}`] },
        );
        return {
          ok: false,
          reason: `${nameOf(subject)} has spent its budget ($${limitUsd.toFixed(2)})`,
          subject,
          spentUsd: Math.round(spentUsd * 1e6) / 1e6,
          limitUsd,
        };
      }
      // A warning is about the next call being close, not about this one being refused.
      const warnAt = Number(budget.warnAt);
      if (warnAt > 0 && spentUsd >= limitUsd * warnAt) {
        await this.deps.bus.publish(
          "budget.warning",
          {
            workspaceId,
            subjectType: subject.type,
            subjectId: idOf(workspaceId, subject),
            spentUsd: Math.round(spentUsd * 1e6) / 1e6,
            limitUsd,
          },
          { ...by, topics: [`ws:${workspaceId}`] },
        );
      }
      if (remainingUsd !== null) {
        tightest = tightest === null ? remainingUsd : Math.min(tightest, remainingUsd);
      }
    }
    return { ok: true, remainingUsd: tightest };
  }
}
