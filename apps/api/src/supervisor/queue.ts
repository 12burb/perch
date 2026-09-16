/**
 * The api → supervisor channel (ADR-0067): a job on the shared queue. Kept apart from the supervisor
 * itself so the api (and the laptop-mode binary) never load the Docker client.
 */
import type { Job } from "@perch/db";
import type { Queue } from "@perch/jobs";

export const SUPERVISOR_QUEUE = "supervisor.ensure";
/**
 * The project volumes belong to a backup too (task 4.4), and the supervisor is the only process
 * that has them mounted — so the api takes the database and the files, then asks for the rest.
 */
export const SUPERVISOR_BACKUP_QUEUE = "supervisor.backup";

/** Enqueues a runner for a workspace (null: the shared runner); the supervisor picks it up. */
export function requestRunner(queue: Queue, workspaceId: string | null): Promise<Job> {
  return queue.enqueue({ queue: SUPERVISOR_QUEUE, payload: { workspaceId } });
}

/** Asks the supervisor to add the project volumes to a backup directory it can also see. */
export function requestVolumeBackup(queue: Queue, dir: string): Promise<Job> {
  return queue.enqueue({ queue: SUPERVISOR_BACKUP_QUEUE, payload: { dir } });
}
