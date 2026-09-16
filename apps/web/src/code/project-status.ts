/**
 * Whether a project list is still moving (ADR-0115).
 *
 * A project being set up is the one thing in Code's list that changes without anybody doing
 * anything. `project.updated` on the socket is how it usually finds out; a missed event used to
 * leave "Setting up" on a project that was ready until the page was reloaded. So the query polls
 * while one is unsettled, and stops the moment none is.
 */

export type ProjectStatus = "pending" | "setting_up" | "ready" | "error";

/** How often to ask while something is still happening; `false` once nothing is. */
export const UNSETTLED_POLL_MS = 2_000;

export function unsettled(rows: readonly { status: ProjectStatus }[] | undefined): boolean {
  return (rows ?? []).some(
    (project) => project.status === "pending" || project.status === "setting_up",
  );
}
