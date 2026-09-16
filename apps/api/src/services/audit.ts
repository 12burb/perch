/**
 * Reading the audit log, and deciding how long it is kept (task 4.5; spec §6, §7.1, §7.7).
 *
 * Nothing here writes a row: the audit subscriber does that, from the bus, and features never
 * write it directly. This is the other half — the page that answers "who did what and when", the
 * export somebody takes to a compliance conversation, and the retention that stops the table
 * growing forever.
 */
import type { AuditActorType, AuditRow, Db, DbHandle } from "@perch/db";
import type { Logger } from "pino";
import {
  type AuditFilter,
  auditActions,
  listAudit,
  listAuditEverywhere,
  pruneAudit,
} from "../repos/audit.ts";
import { getSetting, SETTING_KEYS, setSetting } from "./setup.ts";

export const AUDIT_QUEUE = "audit.retention";
/** The schedule's identity in the jobs table. */
export const RETENTION_KEY = "audit:retention";
/** Daily, an hour after the backup, so a pruned row is in last night's backup first. */
export const RETENTION_CRON = "0 4 * * *";

/** How many rows an export may carry. Beyond this, narrow the filter. */
export const EXPORT_LIMIT = 10_000;

export type AuditQuery = {
  before?: Date;
  limit?: number;
  action?: string;
  actorType?: AuditActorType;
  actorId?: string;
  targetType?: string;
  from?: Date;
  to?: Date;
};

function filter(query: AuditQuery, fallbackLimit: number): AuditFilter {
  return {
    limit: query.limit ?? fallbackLimit,
    ...(query.before ? { before: query.before } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  };
}

/** One CSV field: quoted when it has to be, and never able to start a formula in a spreadsheet. */
export function csvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  // A leading =, +, - or @ is executed by Excel and Sheets; a leading quote is not.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /["\n,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_COLUMNS = [
  "ts",
  "workspace_id",
  "actor_type",
  "actor_id",
  "action",
  "target_type",
  "target_id",
  "ip",
  "details",
] as const;

export function toCsv(rows: readonly AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.ts),
        csvField(row.workspaceId),
        csvField(row.actorType),
        csvField(row.actorId),
        csvField(row.action),
        csvField(row.targetType),
        csvField(row.targetId),
        csvField(row.ip),
        csvField(row.details),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export type AuditDeps = { db: DbHandle; log: Logger; now?: () => Date };

export class AuditService {
  constructor(private readonly deps: AuditDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  list(workspaceId: string, query: AuditQuery = {}): Promise<AuditRow[]> {
    return listAudit(this.db, workspaceId, filter(query, 50));
  }

  /** Across every workspace, for the instance's own page. */
  everywhere(query: AuditQuery = {}): Promise<AuditRow[]> {
    return listAuditEverywhere(this.db, filter(query, 50));
  }

  actions(workspaceId: string): Promise<string[]> {
    return auditActions(this.db, workspaceId);
  }

  /** The rows an export carries: the same filter, capped rather than paged. */
  export(workspaceId: string, query: AuditQuery = {}): Promise<AuditRow[]> {
    return listAudit(this.db, workspaceId, {
      ...filter(query, EXPORT_LIMIT),
      limit: Math.min(query.limit ?? EXPORT_LIMIT, EXPORT_LIMIT),
    });
  }

  /** Days to keep; 0 means forever, which is the default until somebody chooses otherwise. */
  async retentionDays(): Promise<number> {
    const days = await getSetting<number>(this.db, SETTING_KEYS.auditRetentionDays);
    return typeof days === "number" && Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  }

  async setRetentionDays(days: number): Promise<number> {
    const value = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
    await setSetting(this.db, SETTING_KEYS.auditRetentionDays, value);
    return value;
  }

  /** Removes what the retention says is too old. Does nothing at all when it is 0. */
  async prune(): Promise<{ days: number; removed: number }> {
    const days = await this.retentionDays();
    if (days === 0) return { days, removed: 0 };
    const now = this.deps.now?.() ?? new Date();
    const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const removed = await pruneAudit(this.db, before);
    if (removed > 0) {
      this.deps.log.info({ days, removed }, "pruned audit rows past the retention");
    }
    return { days, removed };
  }
}
