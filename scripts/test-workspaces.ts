/**
 * `bun run test`: every workspace's tests, one `bun test` process per workspace (ADR-0168).
 *
 * One process for the whole repository held every PGlite instance the api tests booted, until a
 * db test late in the run could not get memory. A process per workspace bounds what one run
 * holds, and a failure names its workspace. The runs are sequential, as `bun test` itself is:
 * the point is the ceiling, not the clock.
 *
 * Arguments go to every run (`bun run test -- --bail`). To run one file, call `bun test <path>`
 * directly, as before.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Every workspace directory the root package.json names, in order. */
export function workspaceDirs(rootDir = root): string[] {
  const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const base = join(rootDir, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base).sort()) {
        const dir = join(base, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) dirs.push(dir);
      }
    } else if (existsSync(join(rootDir, pattern, "package.json"))) {
      dirs.push(join(rootDir, pattern));
    }
  }
  return dirs;
}

const SKIPPED = new Set(["node_modules", "dist", ".turbo", ".git"]);

/** Every test file under a directory, the way `bun test` finds them. */
export function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...testFilesUnder(path));
    else if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(entry)) out.push(path);
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = workspaceDirs().filter((dir) => testFilesUnder(dir).length > 0);
  const failed: string[] = [];
  for (const dir of dirs) {
    const rel = dir.slice(root.length + 1);
    console.log(`\n=== ${rel} ===`);
    const run = Bun.spawnSync(["bun", "test", ...args], {
      cwd: dir,
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    });
    if (run.exitCode !== 0) failed.push(rel);
  }
  console.log(
    `\n${dirs.length} workspaces with tests: ${failed.length === 0 ? "all passed" : `failed in ${failed.join(", ")}`}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}
