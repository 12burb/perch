/**
 * The project volumes, added to a backup by the one process that can see them (task 4.4).
 *
 * `apps/api` never mounts the projects volume — the supervisor does (spec §1.6, ADR-0067) — so a
 * backup is taken in two halves: the api writes the database, the files and the manifest, then
 * asks here for the working copies. They are a tarball beside the dump, and the manifest is
 * rewritten to say so when it lands.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

export type VolumeBackup = { file: string; bytes: number; projects: number };

/** Every top-level directory under the projects volume is one project's working copy. */
export function projectsIn(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

export async function backupVolumes(
  dir: string,
  log: Logger,
  options: { projects?: string } = {},
): Promise<VolumeBackup> {
  const source = options.projects ?? "/data/projects";
  const file = "projects.tar.gz";
  const out = join(dir, file);
  const projects = projectsIn(source);
  if (projects === 0) {
    log.info({ source }, "no project volumes to back up");
    return patch(dir, { file, bytes: 0, projects: 0 });
  }
  // tar rather than a walk in TypeScript: it keeps symlinks, modes and hard links, which a
  // checked-out repository has and a naive copy quietly loses.
  const proc = Bun.spawn(["tar", "-czf", out, "-C", source, "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`tar exited with ${code}: ${stderr.trim()}`);
  return patch(dir, { file, bytes: statSync(out).size, projects });
}

/** Writes what happened into the manifest the api already left there. */
function patch(dir: string, result: VolumeBackup): VolumeBackup {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return result;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  manifest.projects = result;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return result;
}
