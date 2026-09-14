/**
 * The §7.6 methods a runner answers, keyed by method. Phase 1 fills this table task by task (fs, git,
 * pty, sessions, ports, previews, exec); until then a method is "not available on this runner yet".
 */
import type { ApiToRunnerMethod, RunnerRequestParams } from "@perch/events";
import {
  type ProjectsOptions,
  projectsRoot,
  removeProject,
  setupProject,
  writeProjectFile,
} from "./projects.ts";

export type RunnerHandler<M extends ApiToRunnerMethod> = (
  params: RunnerRequestParams<M>,
) => Promise<unknown>;

export type RunnerHandlers = { [M in ApiToRunnerMethod]?: RunnerHandler<M> };

export type HandlerOptions = { projects?: Partial<ProjectsOptions> };

/**
 * What every runner answers today: the listening-port list (empty until task 1.5 discovers ports),
 * project setup and removal, and file writes into a project (uploads; the rest of fs.* is task 1.5).
 */
export function defaultHandlers(options: HandlerOptions = {}): RunnerHandlers {
  const projects: ProjectsOptions = { root: projectsRoot(), ...options.projects };
  return {
    "ports.list": async () => ({ ports: [] }),
    "project.setup": (params) => setupProject(projects, params),
    "project.remove": (params) => removeProject(projects, params),
    "fs.write": (params) => writeProjectFile(projects, params),
  };
}

export function implementedMethods(handlers: RunnerHandlers): ApiToRunnerMethod[] {
  return (Object.keys(handlers) as ApiToRunnerMethod[]).filter((m) => handlers[m] !== undefined);
}
