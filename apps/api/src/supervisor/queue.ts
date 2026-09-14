/**
 * The api → supervisor channel (ADR-0067): a job on the shared queue. Kept apart from the supervisor
 * itself so the api (and the laptop-mode binary) never load the Docker client.
 */
import type { Job } from "@perch/db";
import type { Queue } from "@perch/jobs";

export const SUPERVISOR_QUEUE = "supervisor.ensure";

/** Enqueues a runner for a workspace (null: the shared runner); the supervisor picks it up. */
export function requestRunner(queue: Queue, workspaceId: string | null): Promise<Job> {
  return queue.enqueue({ queue: SUPERVISOR_QUEUE, payload: { workspaceId } });
}
