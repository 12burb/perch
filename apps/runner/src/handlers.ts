import { existsSync } from "node:fs";
import type { ApiToRunnerMethod, RunnerRequestParams } from "@perch/events";
import { checkpoint, gitApply, restore } from "./checkpoints.ts";
import { exec } from "./exec.ts";
import { fsList, fsRead, fsSearch, fsStat, fsWrite } from "./fs.ts";
import {
  gitBranch,
  gitCommit,
  gitDiff,
  gitMerge,
  gitPush,
  gitStatus,
  worktreeCreate,
  worktreeRemove,
} from "./git.ts";
import { HttpTunnel } from "./http-tunnel.ts";
import type { Notify } from "./notify.ts";
import { type RunnerPolicy, runnerPolicy } from "./policy.ts";
import { listPorts } from "./ports.ts";
import {
  type ProjectsOptions,
  projectConfig,
  projectsRoot,
  removeProject,
  setupProject,
} from "./projects.ts";
import { PtyManager, type PtyOptions } from "./pty.ts";
import { screenshot } from "./screenshot.ts";
import { SessionManager, type SessionsOptions } from "./sessions.ts";
import type { StreamOpener } from "./streams.ts";

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
  /** Shell options (tmux, grace, homes) and how the runner reaches the api's stream endpoint. */
  pty?: Omit<PtyOptions, "root" | "notify" | "streams">;
  streams?: StreamOpener;
  /** Session options (the ACP agents this runner may launch, the default agent, idle reaping). */
  sessions?: Omit<SessionsOptions, "root" | "policy" | "notify" | "homes">;
};

/** Handlers plus what the runner must shut down with them (shells, agent sessions, tunnels). */
export type RunnerServices = {
  handlers: RunnerHandlers;
  ptys: PtyManager;
  sessions: SessionManager;
  /** The preview tunnel (task 1.19); the stream client hands it the sockets for its tokens. */
  tunnel: HttpTunnel;
  close(): void;
};

/**
 * What every runner answers today (tasks 1.4, 1.5, 1.7, 1.9, and 1.19): projects, the fs, git,
 * worktree, ports, exec, pty, session methods (ACP agents), and the preview tunnel. MCP spawning
 * arrives with its task.
 */
export function defaultHandlers(options: HandlerOptions = {}): RunnerHandlers {
  return createServices(options).handlers;
}

export function createServices(options: HandlerOptions = {}): RunnerServices {
  const projects: ProjectsOptions = { root: projectsRoot(), ...options.projects };
  const policy = options.policy ?? runnerPolicy();
  const fs = { root: projects.root, policy, ...(options.notify ? { notify: options.notify } : {}) };
  const git = {
    root: projects.root,
    policy,
    ...(options.notify ? { notify: options.notify } : {}),
  };
  const homes =
    process.env.PERCH_HOMES_DIR || existsSync("/data/homes")
      ? { homes: process.env.PERCH_HOMES_DIR ?? "/data/homes" }
      : {};
  const ptys = new PtyManager({
    root: projects.root,
    ...homes,
    ...options.pty,
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.streams ? { streams: options.streams } : {}),
  });
  const sessions = new SessionManager({
    root: projects.root,
    policy,
    ...homes,
    ...(options.notify ? { notify: options.notify } : {}),
    ...options.sessions,
  });
  const tunnel = new HttpTunnel({
    ...(options.streams ? { streams: options.streams } : {}),
  });
  const handlers: RunnerHandlers = {
    "ports.list": async () => ({ ports: await listPorts() }),
    "http.open": (params) => tunnel.open(params),
    "preview.screenshot": (params) =>
      screenshot({
        port: params.port,
        path: params.path,
        ...(params.width === undefined ? {} : { width: params.width }),
        ...(params.height === undefined ? {} : { height: params.height }),
      }),
    "session.create": (params) => sessions.create(params),
    "session.send": (params) => sessions.send(params),
    "session.permission": (params) => sessions.permission(params),
    "session.cancel": (params) => sessions.cancel(params),
    "session.checkpoint": (params) => checkpoint(git, params),
    "session.restore": (params) => restore(git, params),
    "pty.open": (params) => ptys.open(params),
    "pty.input": async (params) => ({ written: ptys.write(params.pty_id, params.data) }),
    "pty.resize": async (params) => ({
      resized: ptys.resize(params.pty_id, params.cols, params.rows),
    }),
    "pty.close": async (params) => ({ closed: ptys.close(params.pty_id) }),
    "project.setup": (params) => setupProject(projects, params),
    "project.remove": (params) => removeProject(projects, params),
    "project.config": (params) => projectConfig(projects, params),
    "fs.list": (params) => fsList(fs, params),
    "fs.read": (params) => fsRead(fs, params),
    "fs.write": (params) => fsWrite(fs, params),
    "fs.stat": (params) => fsStat(fs, params),
    "fs.search": (params) => fsSearch(fs, params),
    "git.status": (params) => gitStatus(git, params),
    "git.diff": (params) => gitDiff(git, params),
    "git.apply": (params) => gitApply(git, params),
    "git.commit": (params) => gitCommit(git, params),
    "git.push": (params) => gitPush(git, params),
    "git.branch": (params) => gitBranch(git, params),
    "git.merge": (params) => gitMerge(git, params),
    "worktree.create": (params) => worktreeCreate(git, params),
    "worktree.remove": (params) => worktreeRemove(git, params),
    exec: (params) => exec(git, params),
  };
  return {
    handlers,
    ptys,
    sessions,
    tunnel,
    close: () => {
      ptys.closeAll();
      tunnel.close();
      void sessions.closeAll();
    },
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
