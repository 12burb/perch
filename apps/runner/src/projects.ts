/**
 * Projects on a runner (spec §5.1, task 1.4, ADR-0069): each project is a directory at
 * <projects root>/<workspace id>/<project id>, created empty, cloned (a token through git's credential
 * helper, or the workspace deploy key through GIT_SSH_COMMAND; neither touches the command line or a
 * log), or filled by uploads. After setup the runner reads back .perch/project.json and
 * devcontainer.json (JSONC) and runs the devcontainer's postCreateCommand.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  JSON_RPC_ERRORS,
  type ProjectConfigResult,
  type ProjectSetupResult,
  type RunnerRequestParams,
  RunnerRpcError,
} from "@perch/events";
import { simpleGit } from "simple-git";
import { childEnv } from "./env.ts";

export type ProjectsOptions = {
  /** Where projects live; PERCH_PROJECTS_DIR, else /data/projects (the runner image). */
  root: string;
  /** postCreateCommand budget. */
  postCreateTimeoutMs?: number;
  /** git clone budget. */
  cloneTimeoutMs?: number;
};

/**
 * Host variables git must not inherit on a runner: askpass, editor, pager, proxy, and ssh overrides
 * would let the host inject a program into a git call, and GIT_CONFIG* would override the
 * credential helper below (the same list simple-git refuses to pass through).
 */
const STRIPPED_GIT_ENV =
  /^(EDITOR|PAGER|PREFIX|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG.*|GIT_DIR|GIT_WORK_TREE|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_PROXY_COMMAND|GIT_TEMPLATE_DIR)$/;

export function cloneEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(childEnv(base))) {
    if (!STRIPPED_GIT_ENV.test(key)) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", ...extra };
}

/** Credentials embedded in a URL (https://user:token@host/…) must never reach a log or an error. */
export function scrubUrl(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
}

/** Runs git with an explicit environment; returns its (scrubbed) output, throws on a non-zero exit. */
export async function runGit(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const verb = args.find((arg) => !arg.startsWith("-") && arg !== "clone") ?? args[0];
  if (exitCode !== 0) {
    const detail = scrubUrl(stderr.trim().split("\n").slice(-3).join(" ")) || `exit ${exitCode}`;
    throw new Error(`git ${args.includes("clone") ? "clone" : verb} failed: ${detail}`);
  }
  return scrubUrl(`${stdout}${stderr}`.trim());
}

export function projectsRoot(env: Record<string, string | undefined> = process.env): string {
  return env.PERCH_PROJECTS_DIR ?? "/data/projects";
}

export function projectDir(root: string, workspaceId: string, projectId: string): string {
  return join(root, workspaceId, projectId);
}

/** A path inside a project, refusing anything that escapes it. */
export function resolveInside(dir: string, relativePath: string): string {
  const target = resolve(dir, normalize(relativePath));
  const rel = relative(dir, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    return target;
  throw new Error(`path escapes the project: ${relativePath}`);
}

type Setup = RunnerRequestParams<"project.setup">;

/** What git needs for a clone with a token or a deploy key: config and environment, never argv. */
export function gitAuth(
  auth: Extract<Setup["source"], { kind: "clone" }>["auth"],
  keyFile?: string,
) {
  if (!auth) return { config: [] as string[], env: {} as Record<string, string> };
  if (auth.kind === "token") {
    return {
      config: [
        'credential.helper=!f() { echo "username=$PERCH_GIT_USERNAME"; echo "password=$PERCH_GIT_SECRET"; }; f',
      ],
      env: {
        PERCH_GIT_USERNAME: auth.username ?? "x-access-token",
        PERCH_GIT_SECRET: auth.token,
        GIT_TERMINAL_PROMPT: "0",
      },
    };
  }
  if (!keyFile) throw new Error("ssh auth needs a key file");
  return {
    config: [] as string[],
    env: {
      GIT_SSH_COMMAND: `ssh -i ${JSON.stringify(keyFile)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}

function parseJson(text: string, jsonc: boolean): { value: unknown } | { error: string } {
  try {
    return { value: jsonc ? Bun.JSONC.parse(text) : JSON.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** .perch/project.json (JSON) and .devcontainer/devcontainer.json or .devcontainer.json (JSONC). */
export async function readProjectFiles(
  dir: string,
): Promise<
  Pick<ProjectSetupResult, "config" | "configError" | "devcontainer" | "devcontainerError">
> {
  const out: Pick<
    ProjectSetupResult,
    "config" | "configError" | "devcontainer" | "devcontainerError"
  > = { config: null, devcontainer: null };
  const configPath = join(dir, ".perch", "project.json");
  if (existsSync(configPath)) {
    const parsed = parseJson(await Bun.file(configPath).text(), false);
    if ("error" in parsed) out.configError = `.perch/project.json: ${parsed.error}`;
    else out.config = parsed.value;
  }
  const candidates = [
    join(dir, ".devcontainer", "devcontainer.json"),
    join(dir, ".devcontainer.json"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) {
    const parsed = parseJson(await Bun.file(found).text(), true);
    if ("error" in parsed) out.devcontainerError = `${relative(dir, found)}: ${parsed.error}`;
    else out.devcontainer = parsed.value;
  }
  return out;
}

function postCreateCommandOf(devcontainer: unknown): string | null {
  if (typeof devcontainer !== "object" || devcontainer === null) return null;
  const value = (devcontainer as Record<string, unknown>).postCreateCommand;
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.map((v: string) => (/\s/.test(v) ? JSON.stringify(v) : v)).join(" ");
  }
  return null;
}

const OUTPUT_LIMIT = 64 * 1024;

export async function runPostCreate(
  dir: string,
  command: string,
  timeoutMs: number,
): Promise<{ command: string; exitCode: number; output: string }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(process.env, { CI: "1", PERCH: "1" }),
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = `${stdout}${stderr ? `\n${stderr}` : ""}`;
  return {
    command,
    exitCode,
    output: output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n…` : output,
  };
}

/**
 * A project's checked-in files, re-read where the project already is (task 2.18). Nothing about the
 * checkout is touched: this is the api asking what `.perch/project.json` says now.
 */
export async function projectConfig(
  options: ProjectsOptions,
  params: { workspace_id: string; project: string },
): Promise<ProjectConfigResult> {
  const dir = projectDir(options.root, params.workspace_id, params.project);
  if (!existsSync(dir)) {
    throw new RunnerRpcError(JSON_RPC_ERRORS.invalidParams, "the project is not on this runner");
  }
  return readProjectFiles(dir);
}

export async function setupProject(
  options: ProjectsOptions,
  params: Setup,
): Promise<ProjectSetupResult> {
  const dir = projectDir(options.root, params.workspace_id, params.project);
  mkdirSync(join(options.root, params.workspace_id), { recursive: true });
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const source = params.source;
  if (source.kind === "clone") {
    let keyDir: string | null = null;
    try {
      let keyFile: string | undefined;
      if (source.auth?.kind === "ssh") {
        keyDir = await mkdtemp(join(tmpdir(), "perch-key-"));
        keyFile = join(keyDir, "id");
        const key = source.auth.privateKey;
        writeFileSync(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
        chmodSync(keyFile, 0o600);
      }
      const auth = gitAuth(source.auth, keyFile);
      // git is spawned directly: the credential helper and the ssh command are ours, the environment
      // is explicit, and no URL or token is ever placed on the command line by this code.
      const args = [
        ...auth.config.flatMap((entry) => ["-c", entry]),
        "clone",
        ...(source.branch ? ["--branch", source.branch] : []),
        "--",
        source.url,
        dir,
      ];
      await runGit(args, {
        cwd: join(options.root, params.workspace_id),
        env: cloneEnv(process.env, auth.env),
        timeoutMs: options.cloneTimeoutMs ?? 600_000,
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    } finally {
      if (keyDir) await rm(keyDir, { recursive: true, force: true });
    }
  } else {
    mkdirSync(dir, { recursive: true });
    const git = simpleGit({ baseDir: dir }).env(cloneEnv(process.env, {}));
    await git.init([
      "--initial-branch",
      source.kind === "empty" ? (source.defaultBranch ?? "main") : "main",
    ]);
  }
  const git = simpleGit({ baseDir: dir }).env(cloneEnv(process.env, {}));
  let head: string | null = null;
  let defaultBranch: string | null = null;
  try {
    head = (await git.revparse(["HEAD"])).trim() || null;
  } catch {
    // An empty repository has no HEAD yet.
  }
  try {
    // symbolic-ref works on an unborn branch too (an empty project has no commit yet).
    defaultBranch = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim() || null;
  } catch {
    defaultBranch = null; // detached HEAD
  }
  const files = await readProjectFiles(dir);
  const result: ProjectSetupResult = { path: dir, defaultBranch, head, ...files };
  const command = postCreateCommandOf(files.devcontainer);
  if (command && params.postCreate !== false && source.kind !== "empty") {
    result.postCreate = await runPostCreate(dir, command, options.postCreateTimeoutMs ?? 600_000);
  }
  return result;
}

export async function removeProject(
  options: ProjectsOptions,
  params: RunnerRequestParams<"project.remove">,
): Promise<{ removed: boolean }> {
  const dir = projectDir(options.root, params.workspace_id, params.project);
  if (!existsSync(dir)) return { removed: false };
  rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}

export async function writeProjectFile(
  options: ProjectsOptions,
  params: RunnerRequestParams<"fs.write">,
): Promise<{ bytes: number }> {
  const dir = projectDir(options.root, params.workspace_id, params.project);
  if (!existsSync(dir)) throw new Error("project directory does not exist on this runner");
  const target = resolveInside(dir, params.path);
  mkdirSync(join(target, ".."), { recursive: true });
  const bytes =
    params.encoding === "base64"
      ? Buffer.from(params.content, "base64")
      : Buffer.from(params.content, "utf8");
  writeFileSync(target, bytes);
  return { bytes: bytes.length };
}
