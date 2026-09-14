import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRelative, realish } from "../src/paths.ts";

/**
 * Tasks 1.9–1.11: agents report real paths (`/private/var/…` on macOS for a `/var/…` project, a
 * resolved symlink elsewhere), so project-relative paths are taken through the real ancestors of
 * both sides, including files that do not exist yet.
 */
describe("project-relative paths (tasks 1.9–1.11)", () => {
  test("a file reported through a symlinked project dir is relative to the project", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "perch-paths-")));
    const real = join(base, "real");
    const link = join(base, "link");
    mkdirSync(join(real, "src"), { recursive: true });
    symlinkSync(real, link, "junction");
    try {
      expect(projectRelative(link, join(real, "notes.txt"))).toBe("notes.txt");
      expect(projectRelative(real, join(link, "src", "new.ts"))).toBe("src/new.ts");
      expect(projectRelative(link, join(link, "deep", "er", "file.md"))).toBe("deep/er/file.md");
      expect(projectRelative(real, "already/relative.txt")).toBe("already/relative.txt");
      expect(realish(join(link, "missing", "leaf.txt"))).toBe(join(real, "missing", "leaf.txt"));
      expect(realish(link)).toBe(real);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
