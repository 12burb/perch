/**
 * The audit log subscriber (spec §7.7): every workspace-scoped bus event becomes an audit_log row, and
 * `audit.logged` is published for it. Features never write the audit log directly. High-frequency
 * ephemeral events (typing, presence, read state, session deltas, usage ticks) are not audited.
 */
import type { Bus, Unsubscribe } from "@perch/bus";
import type { DbHandle } from "@perch/db";
import type { BusEvent, BusEventName } from "@perch/events";
import type { Logger } from "pino";
import { insertAudit } from "../repos/audit.ts";

export const UNAUDITED_EVENTS: ReadonlySet<BusEventName> = new Set<BusEventName>([
  "audit.logged",
  "typing",
  "presence.changed",
  "read_state.updated",
  "session.delta",
  "session.usage",
  "usage.recorded",
]);

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** The audited object: `member.*` targets the user; otherwise `<head>.*` targets `<head>Id` when present. */
export function auditTarget(
  type: string,
  payload: Record<string, unknown>,
): { type: string; id: string | undefined } {
  const head = type.split(".")[0] ?? type;
  if (head === "member") return { type: "user", id: asId(payload.userId) };
  if (head === "workspace") return { type: "workspace", id: asId(payload.workspaceId) };
  return { type: head, id: asId(payload[`${camel(head)}Id`]) };
}

function asId(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function startAuditSubscriber(deps: { bus: Bus; db: DbHandle; log: Logger }): Unsubscribe {
  return deps.bus.subscribe("*", async (event: BusEvent) => {
    if (UNAUDITED_EVENTS.has(event.type)) return;
    const payload = event.payload as Record<string, unknown>;
    const workspaceId = asId(payload.workspaceId);
    if (!workspaceId) return;
    const { workspaceId: _omit, ...details } = payload;
    const target = auditTarget(event.type, payload);
    const row = await insertAudit(deps.db.db, {
      workspaceId,
      actorType: event.actor?.type ?? "system",
      actorId: event.actor?.id ?? null,
      action: event.type,
      targetType: target.type,
      targetId: target.id ?? null,
      details: {
        ...details,
        ...(event.meta?.requestId ? { requestId: event.meta.requestId } : {}),
      },
      ip: event.meta?.ip ?? null,
      ts: new Date(event.ts),
    });
    await deps.bus.publish("audit.logged", {
      workspaceId,
      auditId: row.id,
      action: event.type,
      actorType: row.actorType,
      ...(row.actorId ? { actorId: row.actorId } : {}),
      targetType: row.targetType,
      ...(row.targetId ? { targetId: row.targetId } : {}),
    });
  });
}
