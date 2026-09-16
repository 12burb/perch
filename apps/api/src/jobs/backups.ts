/**
 * The nightly backup (task 4.4) and the audit prune beside it (task 4.5).
 *
 * The schedule is a cron row like any other, so an instance that was switched off at three in the
 * morning takes its backup when it comes back rather than skipping the night — and the same worker
 * that runs everything else runs this, with no second scheduler to keep alive.
 */
import type { Queue } from "@perch/jobs";
import type { Deps } from "../context.ts";
import { AUDIT_QUEUE, RETENTION_CRON, RETENTION_KEY } from "../services/audit.ts";
import { BACKUPS_QUEUE, NIGHTLY_KEY } from "../services/backups.ts";

type JobHandlers = Parameters<Queue["worker"]>[0]["handlers"];

export function backupJobHandlers(deps: Deps): JobHandlers {
  return {
    [BACKUPS_QUEUE]: async () => {
      if (!deps.backups.root) return;
      const backup = await deps.backups.create();
      deps.log.info({ backup: backup.id, bytes: backup.bytes }, "the nightly backup is written");
    },
  };
}

/** The audit retention runs daily whatever it is set to; at 0 it looks and does nothing. */
export function auditJobHandlers(deps: Deps): JobHandlers {
  return {
    [AUDIT_QUEUE]: async () => {
      await deps.audit.prune();
    },
  };
}

/** Puts the schedule in place, or takes it away when the instance has no backup directory. */
export async function scheduleBackups(deps: Pick<Deps, "env" | "queue" | "log">): Promise<void> {
  if (!deps.env.backup.dir) {
    await deps.queue.unschedule(NIGHTLY_KEY);
    return;
  }
  await deps.queue.schedule({
    key: NIGHTLY_KEY,
    queue: BACKUPS_QUEUE,
    cron: deps.env.backup.cron,
  });
  deps.log.info(
    { cron: deps.env.backup.cron, dir: deps.env.backup.dir, keep: deps.env.backup.keep },
    "backups are scheduled",
  );
}

/** The audit prune, an hour after the backup, so a row that goes is in last night's copy first. */
export async function scheduleAuditRetention(deps: Pick<Deps, "queue">): Promise<void> {
  await deps.queue.schedule({ key: RETENTION_KEY, queue: AUDIT_QUEUE, cron: RETENTION_CRON });
}
