import { index, inet, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamptz } from "../columns.ts";
import type { AuditDetails } from "../shapes/index.ts";
import { workspaces } from "./tenancy.ts";

export const AUDIT_ACTOR_TYPES = ["user", "bot", "system", "runner"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * The audit log (spec §6): one row per audited bus event, written only by the audit subscriber in
 * apps/api (features never write it directly, spec §7.7). Columns follow the spec exactly, including a
 * single `ts` instead of the usual created_at/updated_at pair.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    details: jsonb("details").$type<AuditDetails>().notNull().default({}),
    ip: inet("ip"),
    ts: timestamptz("ts").notNull().defaultNow(),
  },
  (t) => [index("audit_log_workspace_ts_idx").on(t.workspaceId, t.ts.desc())],
);

export type AuditRow = typeof auditLog.$inferSelect;
export type NewAuditRow = typeof auditLog.$inferInsert;
