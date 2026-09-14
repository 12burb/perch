import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Repository invariants from the spec (§0 license split, §1 ground rules, §2 stack).
 * They run as part of `bun run check` so a scaffold-level regression fails CI.
 */

const root = resolve(import.meta.dir, "..");

type PackageJson = {
  name: string;
  license?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[];
};

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
}

function workspaceDirs(): string[] {
  const rootPkg = readPackage(root);
  const dirs: string[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const base = join(root, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const dir = join(base, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) dirs.push(dir);
      }
    } else if (existsSync(join(root, pattern, "package.json"))) {
      dirs.push(join(root, pattern));
    }
  }
  return dirs.sort();
}

const MIT_WORKSPACES = new Set([
  "packages/bot-sdk",
  "packages/ui",
  "packages/events",
  "packages/api-client",
  "connectors",
  "templates",
]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe("repository invariants", () => {
  const dirs = workspaceDirs();

  test("every workspace has a package.json with a name and a typecheck script", () => {
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const pkg = readPackage(dir);
      expect(pkg.name, dir).toMatch(/^@perch\/[a-z0-9-]+$|^perch-[a-z0-9-]+$/);
      expect(pkg.scripts?.typecheck, `${pkg.name} typecheck script`).toBeDefined();
    }
  });

  test("the license split follows ADR-0007: MIT packages carry MIT, everything else AGPL-3.0-only", () => {
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain(
      "GNU AFFERO GENERAL PUBLIC LICENSE",
    );
    for (const dir of dirs) {
      const rel = dir.slice(root.length + 1);
      const pkg = readPackage(dir);
      if (rel.startsWith("spikes/")) continue;
      if (MIT_WORKSPACES.has(rel)) {
        expect(pkg.license, rel).toBe("MIT");
        expect(readFileSync(join(dir, "LICENSE"), "utf8"), rel).toContain("MIT License");
      } else {
        expect(pkg.license, rel).toBe("AGPL-3.0-only");
      }
    }
  });

  test("dependencies are pinned to exact versions (spec §1.3) except workspace links", () => {
    for (const dir of [root, ...dirs]) {
      const pkg = readPackage(dir);
      for (const group of [pkg.dependencies, pkg.devDependencies]) {
        for (const [name, version] of Object.entries(group ?? {})) {
          if (version.startsWith("workspace:")) continue;
          expect(version, `${pkg.name} → ${name}`).toMatch(EXACT_VERSION);
        }
      }
    }
  });

  test("the toolchain is pinned: packageManager names a Bun version", () => {
    const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    expect(rootPkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  });

  test("no workspace ships an .env file", () => {
    for (const dir of [root, ...dirs]) {
      expect(existsSync(join(dir, ".env")), `${dir}/.env`).toBe(false);
    }
  });
});
