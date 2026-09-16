/**
 * The instance's own endpoints (spec §7.1 `/api/admin/backup`; task 4.4).
 *
 * These are about the Perch rather than a workspace inside it, so the guard is not a membership:
 * it is the account this instance was set up with. A backup is the most sensitive thing an
 * instance can hand out — it is every workspace at once — so nothing here is a member's right.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { currentUser, requireUser } from "../auth/middleware.ts";
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
  const guard = async (userId: string) => {
    if (!(await isInstanceAdmin(deps.db.db, userId))) {
      throw new PerchError("forbidden", "only this instance's admin account may do that", {}, 403);
    }
  };

  app.openapi(listRoute, async (c) => {
    await guard(currentUser(c).id);
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
    await guard(currentUser(c).id);
    const backup = await deps.backups.create();
    return c.json(view(backup), 201);
  });
}
