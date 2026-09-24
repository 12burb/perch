/**
 * The instance's own endpoints (spec §7.1 `/api/admin/backup`; task 4.4).
 *
 * These are about the Perch rather than a workspace inside it, so the guard is not a membership:
 * it is the account this instance was set up with. A backup is the most sensitive thing an
 * instance can hand out — it is every workspace at once — so nothing here is a member's right.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { AUDIT_ACTOR_TYPES } from "@perch/db";
import { currentUser, requireUser } from "../auth/middleware.ts";
import { type Caller, tokenGate } from "../auth/token-gate.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import type { BackupSummary } from "../services/backups.ts";
import { isInstanceAdmin } from "../services/setup.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const backupSchema = z
  .object({
    id: z.string(),
    created_at: z.string(),
    bytes: z.number().int(),
    rows: z.number().int(),
    tables: z.number().int(),
    files: z.number().int(),
    /** Whether the vault key travelled with it, and the fingerprint of the key that did. */
    master_key_included: z.boolean(),
    master_key_fingerprint: z.string(),
    /** The project volumes, when the supervisor has added them. */
    projects: z.number().int().nullable(),
  })
  .openapi("Backup");

const listRoute = createRoute({
  method: "get",
  path: "/api/admin/backup",
  tags: ["system"],
  summary: "The backups this instance has taken, newest first",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: {
      description: "Backups, and the schedule that takes them",
      content: {
        "application/json": {
          schema: z
            .object({
              /** Null when this instance takes no backups of its own. */
              directory: z.string().nullable(),
              cron: z.string().nullable(),
              keep: z.number().int(),
              backups: z.array(backupSchema),
            })
            .openapi("Backups"),
        },
      },
    },
    ...errorResponses(403),
  },
});

const takeRoute = createRoute({
  method: "post",
  path: "/api/admin/backup",
  tags: ["system"],
  summary: "Take a backup now",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    201: { description: "The backup", content: { "application/json": { schema: backupSchema } } },
    ...errorResponses(403, 409),
  },
});

const settingsSchema = z
  .object({
    /** Days of audit log to keep; 0 keeps everything. */
    audit_retention_days: z.number().int().min(0).max(3650),
    /** What backups this instance takes, repeated here so one page answers "is it looked after". */
    backup: z.object({
      directory: z.string().nullable(),
      cron: z.string().nullable(),
      keep: z.number().int(),
      include_key: z.boolean(),
    }),
  })
  .openapi("InstanceSettings");

const settingsRoute = createRoute({
  method: "get",
  path: "/api/admin/settings",
  tags: ["system"],
  summary: "What this instance is set to, beyond its environment",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  responses: {
    200: {
      description: "Settings",
      content: { "application/json": { schema: settingsSchema } },
    },
    ...errorResponses(403),
  },
});

const patchSettingsRoute = createRoute({
  method: "patch",
  path: "/api/admin/settings",
  tags: ["system"],
  summary: "Change what this instance keeps",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ audit_retention_days: z.number().int().min(0).max(3650) })
            .openapi("PatchInstanceSettings"),
        },
      },
    },
  },
  responses: {
    200: { description: "Settings", content: { "application/json": { schema: settingsSchema } } },
    ...errorResponses(403, 422),
  },
});

const auditRowSchema = z
  .object({
    id: z.uuid(),
    ts: z.string(),
    workspace_id: z.uuid(),
    actor_type: z.enum(AUDIT_ACTOR_TYPES),
    actor_id: z.uuid().nullable(),
    action: z.string(),
    target_type: z.string(),
    target_id: z.uuid().nullable(),
    ip: z.string().nullable(),
  })
  .openapi("InstanceAuditRow");

const auditRoute = createRoute({
  method: "get",
  path: "/api/admin/audit",
  tags: ["system"],
  summary: "The audit log across every workspace, newest first",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    query: z.object({
      before: z.iso.datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      action: z.string().min(1).max(64).optional(),
      actor_type: z.enum(AUDIT_ACTOR_TYPES).optional(),
      actor_id: z.uuid().optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
    }),
  },
  responses: {
    200: {
      description: "Audit rows",
      content: { "application/json": { schema: z.object({ rows: z.array(auditRowSchema) }) } },
    },
    ...errorResponses(403),
  },
});

function view(backup: BackupSummary) {
  return {
    id: backup.id,
    created_at: backup.createdAt,
    bytes: backup.bytes,
    rows: backup.manifest.database.rows,
    tables: backup.manifest.database.tables,
    files: backup.manifest.files.count,
    master_key_included: backup.manifest.masterKey.included,
    master_key_fingerprint: backup.manifest.masterKey.fingerprint,
    projects: backup.manifest.projects?.projects ?? null,
  };
}

export function registerAdmin(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /**
   * The instance's admin account, signed in or through a wide admin-scoped token: a narrower token
   * the admin handed to a script must not reach the whole instance (ADR-0172).
   */
  const guard = async (c: Caller) => {
    const userId = currentUser(c).id;
    if (!(await isInstanceAdmin(deps.db.db, userId))) {
      throw new PerchError("forbidden", "only this instance's admin account may do that", {}, 403);
    }
    tokenGate(c, "admin", null);
  };

  app.openapi(listRoute, async (c) => {
    await guard(c);
    return c.json(
      {
        directory: deps.backups.root ?? null,
        cron: deps.backups.root ? deps.env.backup.cron : null,
        keep: deps.env.backup.keep,
        backups: deps.backups.list().map(view),
      },
      200,
    );
  });

  app.openapi(takeRoute, async (c) => {
    await guard(c);
    const backup = await deps.backups.create();
    return c.json(view(backup), 201);
  });

  const settings = async () => ({
    audit_retention_days: await deps.audit.retentionDays(),
    backup: {
      directory: deps.backups.root ?? null,
      cron: deps.backups.root ? deps.env.backup.cron : null,
      keep: deps.env.backup.keep,
      include_key: deps.env.backup.includeKey,
    },
  });

  app.openapi(settingsRoute, async (c) => {
    await guard(c);
    return c.json(await settings(), 200);
  });

  app.openapi(patchSettingsRoute, async (c) => {
    await guard(c);
    await deps.audit.setRetentionDays(c.req.valid("json").audit_retention_days);
    return c.json(await settings(), 200);
  });

  app.openapi(auditRoute, async (c) => {
    await guard(c);
    const query = c.req.valid("query");
    const rows = await deps.audit.everywhere({
      limit: query.limit,
      ...(query.before ? { before: new Date(query.before) } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.actor_type ? { actorType: query.actor_type } : {}),
      ...(query.actor_id ? { actorId: query.actor_id } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    });
    return c.json(
      {
        rows: rows.map((row) => ({
          id: row.id,
          ts: row.ts.toISOString(),
          workspace_id: row.workspaceId,
          actor_type: row.actorType,
          actor_id: row.actorId,
          action: row.action,
          target_type: row.targetType,
          target_id: row.targetId,
          ip: row.ip,
        })),
      },
      200,
    );
  });
}
