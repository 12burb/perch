import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDco } from "./check-dco.ts";

/** Builds a throwaway repository with one signed-off commit and one unsigned commit. */
function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

describe("DCO check", () => {
  let repo = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "perch-dco-"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-s", "-m", "feat: signed");
    git(repo, "tag", "base");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "feat: unsigned");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("passes when every commit in the range is signed off", () => {
    const result = checkDco("base", repo);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  test("fails and names the commit when a sign-off is missing", () => {
    const result = checkDco("base..HEAD", repo);
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.failures[0]).toContain("missing a Signed-off-by trailer");
  });

  test("this repository's own history is signed off", () => {
    const result = checkDco("HEAD");
    expect(result.checked).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });
});

describe("DCO check on merge commits", () => {
  let repo = "";
  let shallow = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "perch-dco-merge-"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-s", "-m", "feat: base");
    git(repo, "tag", "base");
    git(repo, "checkout", "-q", "-b", "topic");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-s", "-m", "feat: on the topic branch");
    git(repo, "checkout", "-q", "main");
    // An unsigned merge commit, like the one GitHub synthesizes for a pull request's merge ref.
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge topic into main", "topic");
    // A depth-1 clone grafts the merge's parents away.
    shallow = mkdtempSync(join(tmpdir(), "perch-dco-shallow-"));
    git(shallow, "clone", "-q", "--depth", "1", `file://${repo}`, ".");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(shallow, { recursive: true, force: true });
  });

  test("an unsigned merge commit is exempt; the commits it merges are still checked", () => {
    const result = checkDco("base..HEAD", repo);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  test("the merge stays exempt at the boundary of a shallow clone", () => {
    const result = checkDco("HEAD", shallow);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });
});
