/**
 * Paths an agent reports, made project-relative (tasks 1.9–1.11). Agents and CLIs often hand back
 * the real path of a file (`/private/var/…` on macOS where the runner holds `/var/…`, a resolved
 * symlink elsewhere), so both sides are compared through their real ancestors before the relative
 * path is taken; a file that does not exist yet resolves through its nearest existing ancestor.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The real path of `path`, resolving through the nearest existing ancestor when it is not there yet. */
export function realish(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) {
      try {
        current = realpathSync.native(current);
      } catch {
        // permissions or a dangling link: keep what we have
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return missing.length > 0 ? resolve(current, ...missing) : current;
}

/** `file` relative to the project directory `cwd`, with forward slashes; a relative input stays. */
export function projectRelative(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(realish(cwd), realish(file)) : file;
  return rel.split(sep).join("/");
}
