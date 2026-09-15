/**
 * Indexing a repository, off the request (spec §5.7 "codebase index … on a job"; task 2.17).
 *
 * Reading every file of a project and embedding it takes longer than a request should, so the POST
 * queues this and `project.updated` says when it landed. The job is the only place that needs both
 * halves — the service that indexes, and the runner link that reads — so it is the one module that
 * imports across that seam.
 */
import type { Queue } from "@perch/jobs";
import type { Deps } from "../context.ts";
import { projectDeps } from "../routes/projects.ts";
import { getProject, projectRunnerLink } from "../services/projects.ts";
import { REPO_INDEX_QUEUE } from "../services/repo-index.ts";

type JobHandlers = Parameters<Queue["worker"]>[0]["handlers"];

export function repoIndexJobHandlers(deps: Deps): JobHandlers {
  return {
    [REPO_INDEX_QUEUE]: async (job) => {
      const payload = job.payload as Record<string, unknown>;
      const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : "";
      const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
      const userId = typeof payload.userId === "string" ? payload.userId : "";
      if (!workspaceId || !projectId || !userId) return;
      const project = await getProject(deps.db.db, workspaceId, projectId);
      // A project that has gone is not an error the queue should retry.
      if (!project) return;
      const link = await projectRunnerLink(projectDeps(deps), project, userId);
      const result = await deps.repoIndex.index({
        project,
        link,
        userId,
        by: { actor: { type: "system" }, meta: {} },
      });
      deps.log.info(
        { projectId, chunks: result.chunks, files: result.files, embedded: result.embedded },
        "indexed a project",
      );
    },
  };
}
