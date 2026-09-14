import type { ApiToRunnerMethod, RunnerRequestParams } from "@perch/events";
import { exec } from "./exec.ts";
import { fsList, fsRead, fsSearch, fsStat, fsWrite } from "./fs.ts";
import {
  gitBranch,
  gitCommit,
  gitDiff,
  gitPush,
  gitStatus,
  worktreeCreate,
  worktreeRemove,
} from "./git.ts";
import type { Notify } from "./notify.ts";
import { type RunnerPolicy, runnerPolicy } from "./policy.ts";
import { listPorts } from "./ports.ts";
import { type ProjectsOptions, projectsRoot, removeProject, setupProject } from "./projects.ts";

export type RunnerHandler<M extends ApiToRunnerMethod> = (
  params: RunnerRequestParams<M>,
) => Promise<unknown>;

export type RunnerHandlers = { [M in ApiToRunnerMethod]?: RunnerHandler<M> };

export type HandlerOptions = {
  projects?: Partial<ProjectsOptions>;
  /** The policy hook every fs, git, and exec call goes through (default: the built-in rules). */
  policy?: RunnerPolicy;
  /** Where fs.changed and other handler-originated notifications go. */
  notify?: Notify;
};

/**
 * What every runner answers today (tasks 1.4 and 1.5): projects, the fs, git, worktree, ports, and
 * exec methods. PTY, sessions, the preview tunnel, and MCP spawning arrive with their tasks.
 */
export function defaultHandlers(options: HandlerOptions = {}): RunnerHandlers {
  const projects: ProjectsOptions = { root: projectsRoot(), ...options.projects };
  const policy = options.policy ?? runnerPolicy();
  const fs = { root: projects.root, policy, ...(options.notify ? { notify: options.notify } : {}) };
  const git = { root: projects.root, policy };
  return {
    "ports.list": async () => ({ ports: await listPorts() }),
    "project.setup": (params) => setupProject(projects, params),
    "project.remove": (params) => removeProject(projects, params),
    "fs.list": (params) => fsList(fs, params),
    "fs.read": (params) => fsRead(fs, params),
    "fs.write": (params) => fsWrite(fs, params),
    "fs.stat": (params) => fsStat(fs, params),
    "fs.search": (params) => fsSearch(fs, params),
    "git.status": (params) => gitStatus(git, params),
    "git.diff": (params) => gitDiff(git, params),
    "git.commit": (params) => gitCommit(git, params),
    "git.push": (params) => gitPush(git, params),
    "git.branch": (params) => gitBranch(git, params),
    "worktree.create": (params) => worktreeCreate(git, params),
    "worktree.remove": (params) => worktreeRemove(git, params),
    exec: (params) => exec(git, params),
  };
}

export function implementedMethods(handlers: RunnerHandlers): ApiToRunnerMethod[] {
  return (Object.keys(handlers) as ApiToRunnerMethod[]).filter((m) => handlers[m] !== undefined);
}

/** A JSON-RPC error code carried by a thrown error (PolicyDenied), else the internal code. */
export function errorCode(error: unknown, fallback: number): number {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : fallback;
}
