/**
 * A workspace's own directory of each runner volume (ADR-0171). A docker-mode runner container
 * mounts `<workspace id>/` of the homes volume at /data/homes and `<workspace id>/` of the projects
 * volume at /data/projects/<workspace id>, so it sees its own workspace's files and nobody else's.
 * A volume subpath (or the bind it falls back to) must exist before the container is created; the
 * supervisor makes both through its own mounts of the two volumes, which the compose file puts at
 * the same paths the runner uses.
 *
 * Homes were one per person across every workspace before this; they are one per person per
 * workspace now. The first time a workspace's homes directory is made, each member's old home
 * (`/data/homes/<user id>` at the volume's root) is copied into it, once — so a CLI someone had
 * already signed in to stays signed in — and the copy is the workspace's own from then on.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lchownSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

/** Where this process sees the two volumes. */
export type VolumeRoots = { homes: string; projects: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A workspace id is a path segment here: nothing else may be one. */
export function assertWorkspaceId(id: string): void {
  if (!UUID.test(id)) throw new Error(`not a workspace id: ${JSON.stringify(id)}`);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : String(error);
}

/** The volume's root as this process sees it, or a plain word on what to fix. */
function volumeRoot(name: "homes" | "projects", root: string): void {
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(
      `the supervisor sees no ${name} volume at ${root}; it mounts both runner volumes at the paths the runners use (deploy/docker-compose.yml) to give each workspace its own directory of them`,
    );
  }
}

function makeDir(name: "homes" | "projects", path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o755 });
  } catch (error) {
    const uid = process.getuid?.();
    throw new Error(
      `the supervisor cannot create ${path} (${codeOf(error)}); the ${name} volume's root must be writable by the supervisor's user${uid === undefined ? "" : ` (uid ${uid})`} — see docs/deploy.md`,
    );
  }
}

/**
 * `cp -a`, in TypeScript: directories, files, symlinks (as links, never followed), modes and times;
 * ownership too when this process may change it. Anything else (a socket, a fifo) is left behind.
 */
export function copyTree(source: string, target: string): void {
  const stats = lstatSync(source);
  const root = process.getuid?.() === 0;
  if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    if (root) lchownSync(target, stats.uid, stats.gid);
    lutimesSync(target, stats.atime, stats.mtime);
    return;
  }
  if (stats.isDirectory()) {
    mkdirSync(target, { mode: 0o700 });
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry));
  } else if (stats.isFile()) {
    copyFileSync(source, target);
  } else {
    return;
  }
  if (root) lchownSync(target, stats.uid, stats.gid);
  chmodSync(target, stats.mode & 0o7777);
  utimesSync(target, stats.atime, stats.mtime);
}

/**
 * Makes `<workspace>/` in both volumes when it is not there yet, copying members' legacy homes in
 * the first time. The homes directory is filled beside its final name and renamed into place, so a
 * supervisor stopped halfway leaves nothing that looks finished, and the next attempt starts over.
 */
export function prepareWorkspaceDirs(
  roots: VolumeRoots,
  workspaceId: string,
  memberIds: string[],
  log?: Logger,
): { homes: string; projects: string; copied: string[] } {
  assertWorkspaceId(workspaceId);
  volumeRoot("homes", roots.homes);
  volumeRoot("projects", roots.projects);
  const projects = join(roots.projects, workspaceId);
  makeDir("projects", projects);
  const homes = join(roots.homes, workspaceId);
  const copied: string[] = [];
  if (!existsSync(homes)) {
    const partial = join(roots.homes, `.${workspaceId}.partial`);
    rmSync(partial, { recursive: true, force: true });
    makeDir("homes", partial);
    for (const userId of memberIds) {
      if (!UUID.test(userId) || userId === workspaceId) continue;
      const legacy = join(roots.homes, userId);
      let isDir = false;
      try {
        isDir = lstatSync(legacy).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      copyTree(legacy, join(partial, userId));
      copied.push(userId);
    }
    renameSync(partial, homes);
    if (copied.length > 0) {
      log?.info(
        { workspaceId, members: copied.length },
        "copied members' homes into the workspace's own homes directory",
      );
    }
  }
  return { homes, projects, copied };
}
