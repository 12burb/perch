/**
 * Projects (spec §5.1, task 1.4, ADR-0069): a row in the workspace and a directory on a runner. The
 * row is created at once; the directory is set up asynchronously on a runner the workspace may use
 * (or one the supervisor is asked to start), and the row's status follows: pending → setting_up →
 * ready | error, each step a project.updated event. Clone credentials pass straight through to the
 * runner over the control channel: a token is never stored, the deploy key is decrypted only here.
 */
import type { Bus } from "@perch/bus";
import { type Db, type Project, projectConfigSchema } from "@perch/db";
import {
  type ProjectSetupResult,
  projectSetupResultSchema,
  type RunnerCallParams,
  type RunnerLink,
} from "@perch/events";
import type { Queue } from "@perch/jobs";
import type { Vault } from "@perch/vault";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import type { Logger } from "../logging.ts";
import {
  deleteProject as deleteRow,
  findProject,
  findProjectByKey,
  insertProject,
  listProjects as listRows,
  updateProject,
} from "../repos/projects.ts";
import { findRunnerById } from "../repos/runners.ts";
import type { RunnerRegistry } from "../runners/registry.ts";
import { requestRunner } from "../supervisor/queue.ts";
import { decryptDeployKey } from "./deploy-keys.ts";
import { slugify } from "./workspaces.ts";

export type ProjectDeps = {
  db: Db;
  bus: Bus;
  vault: Vault;
  queue: Queue;
  registry: RunnerRegistry;
  log: Logger;
};

export type CloneAuth =
  | { kind: "token"; token: string; username?: string }
  | { kind: "deploy_key" };

export type ProjectSourceInput =
  | { kind: "empty"; defaultBranch?: string }
  | { kind: "upload" }
  | { kind: "clone"; repoUrl: string; branch?: string; auth?: CloneAuth };

export type CreateProjectInput = {
  workspaceId: string;
  name: string;
  key?: string;
  source: ProjectSourceInput;
  /** The member creating it; local runners serve only their owner. */
  userId: string;
  by: ActorContext;
};

export type SetupOptions = {
  /** How long to wait for a runner the supervisor was asked to start. */
  runnerWaitMs?: number;
};

/** How long a project waits for a runner before it is marked failed. */
export const RUNNER_WAIT_MS = 120_000;

export const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Credentials never travel inside a URL: they go in the auth field, to the runner, and nowhere else. */
export function validateRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw PerchError.validation("repo_url is not a valid URL", { field: "repo_url" });
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
      throw PerchError.validation("repo_url must be https, http, ssh, or git", {
        field: "repo_url",
      });
    }
    // ssh://git@host is the ssh user, not a secret; anything with a password, or a user on http(s), is.
    const httpUser = ["https:", "http:"].includes(parsed.protocol) && parsed.username;
    if (parsed.password || httpUser) {
      throw PerchError.validation("put the token in auth, not in repo_url", { field: "repo_url" });
    }
    return trimmed;
  }
  // scp-like: git@github.com:owner/repo.git
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(trimmed)) return trimmed;
  throw PerchError.validation("repo_url must be an https, ssh, or git@host:path URL", {
    field: "repo_url",
  });
}

export function projectKeyFrom(name: string): string {
  const slug = slugify(name).slice(0, 63);
  return PROJECT_KEY.test(slug) ? slug : "project";
}

function scrub(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
}

export function listProjects(db: Db, workspaceId: string): Promise<Project[]> {
  return listRows(db, workspaceId);
}

export function getProject(db: Db, workspaceId: string, id: string): Promise<Project | null> {
  return findProject(db, workspaceId, id);
}

/** The row now, and a promise for the directory (routes drop it; tests await it). */
export async function createProject(
  deps: ProjectDeps,
  input: CreateProjectInput,
  options: SetupOptions = {},
): Promise<{ project: Project; setup: Promise<Project> }> {
  const key = (input.key ?? projectKeyFrom(input.name)).toLowerCase();
  if (!PROJECT_KEY.test(key)) {
    throw PerchError.validation("key must be lowercase letters, digits, and dashes", {
      field: "key",
    });
  }
  if (await findProjectByKey(deps.db, input.workspaceId, key)) {
    throw PerchError.conflict("a project with this key already exists", { key });
  }
  const source = input.source;
  const repoUrl = source.kind === "clone" ? validateRepoUrl(source.repoUrl) : null;
  const defaultBranch =
    source.kind === "empty"
      ? source.defaultBranch
      : source.kind === "clone"
        ? source.branch
        : undefined;
  const project = await insertProject(deps.db, {
    workspaceId: input.workspaceId,
    key,
    name: input.name.trim(),
    source: source.kind,
    repoUrl,
    ...(defaultBranch ? { defaultBranch } : {}),
    createdBy: input.userId,
  });
  await deps.bus.publish(
    "project.created",
    { workspaceId: project.workspaceId, projectId: project.id },
    input.by,
  );
  const setup = runSetup(deps, project, source, input.userId, input.by, options).catch(
    (error: unknown) => {
      deps.log.error({ err: error, projectId: project.id }, "project setup crashed");
      return project;
    },
  );
  return { project, setup };
}

type Candidate = { link: RunnerLink; workspaceId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The runner row behind a link; the in-process runner has none (its id is not a row id). */
async function runnerRowOf(db: Db, linkId: string) {
  return UUID.test(linkId) ? findRunnerById(db, linkId) : null;
}

/** Connected runners this member may use: hosted ones, the shared one, and their own machines. */
async function usableRunners(
  deps: Pick<ProjectDeps, "db" | "registry">,
  workspaceId: string,
  userId: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const entry of deps.registry.forWorkspace(workspaceId)) {
    const row = await runnerRowOf(deps.db, entry.link.id);
    if (row && row.ownerUserId !== null && row.ownerUserId !== userId) continue;
    out.push({ link: entry.link, workspaceId: entry.workspaceId });
  }
  // The workspace's own hosted runner first, then the shared or in-process one.
  return out.sort((a, b) => Number(b.workspaceId !== null) - Number(a.workspaceId !== null));
}

async function acquireRunner(
  deps: ProjectDeps,
  workspaceId: string,
  userId: string,
  waitMs: number,
): Promise<RunnerLink | null> {
  const now = await usableRunners(deps, workspaceId, userId);
  if (now[0]) return now[0].link;
  // Ask the supervisor for one and wait for it to come online.
  const online = new Promise<void>((resolve) => {
    const unsubscribe = deps.bus.subscribe("runner.online", (event) => {
      const ws = event.payload.workspaceId;
      if (ws === null || ws === workspaceId) {
        unsubscribe();
        resolve();
      }
    });
    setTimeout(() => {
      unsubscribe();
      resolve();
    }, waitMs).unref?.();
  });
  await requestRunner(deps.queue, workspaceId);
  await online;
  const later = await usableRunners(deps, workspaceId, userId);
  return later[0]?.link ?? null;
}

type RunnerSource = RunnerCallParams<"project.setup">["source"];

async function runnerSource(
  deps: ProjectDeps,
  project: Project,
  source: ProjectSourceInput,
): Promise<RunnerSource> {
  switch (source.kind) {
    case "empty":
      return { kind: "empty", defaultBranch: project.defaultBranch };
    case "upload":
      return { kind: "upload" };
    case "clone": {
      const base = { kind: "clone" as const, url: project.repoUrl ?? source.repoUrl };
      const branch = source.branch ? { branch: source.branch } : {};
      if (!source.auth) return { ...base, ...branch };
      if (source.auth.kind === "token") {
        const username = source.auth.username ? { username: source.auth.username } : {};
        return {
          ...base,
          ...branch,
          auth: { kind: "token", token: source.auth.token, ...username },
        };
      }
      const privateKey = await decryptDeployKey(deps, project.workspaceId);
      if (!privateKey) {
        throw new Error("this workspace has no deploy key yet; open the deploy key first");
      }
      return { ...base, ...branch, auth: { kind: "ssh", privateKey } };
    }
  }
}

/** What a finished setup writes back: validated config, defaults applied, the checkout facts. */
export function applySetupResult(project: Project, result: ProjectSetupResult) {
  const parsed = projectConfigSchema.safeParse(result.config ?? {});
  const config = parsed.success ? parsed.data : {};
  const configError = result.configError
    ? result.configError
    : parsed.success
      ? null
      : `.perch/project.json: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")}`;
  const devcontainer =
    typeof result.devcontainer === "object" &&
    result.devcontainer !== null &&
    !Array.isArray(result.devcontainer)
      ? (result.devcontainer as Record<string, unknown>)
      : null;
  const notes: string[] = [];
  if (result.devcontainerError) notes.push(result.devcontainerError);
  if (result.postCreate && result.postCreate.exitCode !== 0) {
    const tail = result.postCreate.output.trim().split("\n").slice(-3).join(" ");
    notes.push(`postCreateCommand exited ${result.postCreate.exitCode}${tail ? `: ${tail}` : ""}`);
  }
  return {
    status: "ready" as const,
    statusMessage: notes.length ? scrub(notes.join(" · ")).slice(0, 1000) : null,
    head: result.head,
    defaultBranch: result.defaultBranch ?? project.defaultBranch,
    defaultEngine: config.engine ?? project.defaultEngine,
    config,
    configError,
    devcontainer,
  };
}

async function runSetup(
  deps: ProjectDeps,
  project: Project,
  source: ProjectSourceInput,
  userId: string,
  by: ActorContext,
  options: SetupOptions,
): Promise<Project> {
  const publish = (changes: string[]) =>
    deps.bus.publish(
      "project.updated",
      { workspaceId: project.workspaceId, projectId: project.id, changes },
      by,
    );
  const fail = async (message: string) => {
    const row = await updateProject(deps.db, project.id, {
      status: "error",
      statusMessage: scrub(message).slice(0, 1000),
    });
    await publish(["status"]);
    return row;
  };
  const link = await acquireRunner(
    deps,
    project.workspaceId,
    userId,
    options.runnerWaitMs ?? RUNNER_WAIT_MS,
  );
  if (!link) return fail("no runner is available for this workspace");
  const runnerRow = await runnerRowOf(deps.db, link.id);
  await updateProject(deps.db, project.id, {
    status: "setting_up",
    runnerId: runnerRow?.id ?? null,
  });
  await publish(["status", "runner_id"]);
  try {
    const params = await runnerSource(deps, project, source);
    const raw = await link.call("project.setup", {
      workspace_id: project.workspaceId,
      user_id: userId,
      project: project.id,
      source: params,
    });
    const result = projectSetupResultSchema.parse(raw);
    const row = await updateProject(deps.db, project.id, applySetupResult(project, result));
    await publish(["status", "head", "config"]);
    return row;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Paths a client may write: relative, no `..`, no drive letters. */
export function validateProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw PerchError.validation(`invalid path: ${path}`, { field: "file" });
  }
  return normalized;
}

/** Writes uploaded files into a ready project on its runner. */
export async function uploadProjectFiles(
  deps: ProjectDeps,
  project: Project,
  files: { path: string; content: Uint8Array }[],
  userId: string,
  by: ActorContext,
): Promise<{ written: number }> {
  if (project.status !== "ready") {
    throw PerchError.conflict("the project is not ready yet", { status: project.status });
  }
  const live = project.runnerId ? deps.registry.get(project.runnerId) : undefined;
  const link = live?.link ?? (await usableRunners(deps, project.workspaceId, userId))[0]?.link;
  if (!link) throw PerchError.conflict("the project's runner is offline");
  const paths = files.map((f) => validateProjectPath(f.path));
  let written = 0;
  for (const [i, file] of files.entries()) {
    await link.call("fs.write", {
      workspace_id: project.workspaceId,
      user_id: userId,
      project: project.id,
      path: paths[i] ?? file.path,
      content: Buffer.from(file.content).toString("base64"),
      encoding: "base64",
    });
    written += 1;
  }
  await deps.bus.publish(
    "project.updated",
    { workspaceId: project.workspaceId, projectId: project.id, changes: ["files"] },
    by,
  );
  return { written };
}

/** Removes the row and, best effort, the directory on its runner. */
export async function deleteProject(
  deps: ProjectDeps,
  project: Project,
  userId: string,
  by: ActorContext,
): Promise<boolean> {
  // The project's runner, else any the member may use (the in-process runner has no row).
  const live = project.runnerId ? deps.registry.get(project.runnerId) : undefined;
  const link = live?.link ?? (await usableRunners(deps, project.workspaceId, userId))[0]?.link;
  if (link) {
    try {
      await link.call("project.remove", {
        workspace_id: project.workspaceId,
        user_id: userId,
        project: project.id,
      });
    } catch (error) {
      deps.log.warn({ err: error, projectId: project.id }, "project.remove on the runner failed");
    }
  }
  const removed = await deleteRow(deps.db, project.workspaceId, project.id);
  if (removed) {
    await deps.bus.publish(
      "project.deleted",
      { workspaceId: project.workspaceId, projectId: project.id },
      by,
    );
  }
  return removed;
}
