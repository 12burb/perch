import { describe, expect, test } from "bun:test";
import { enforce, PolicyDenied, runnerPolicy } from "../src/policy.ts";

/**
 * Task 1.5: the policy hook every fs, git, and exec call goes through, with the built-in floor:
 * destructive and publishing commands, force pushes, git internals, exec confined to the projects root.
 */

const P = "0190f2d0-0000-7000-8000-0000000000dd";
const ROOT = "/data/projects";

describe("runner policy (task 1.5)", () => {
  const policy = runnerPolicy();
  const exec = (command: string, cwd = `${ROOT}/ws/p`) =>
    policy({ kind: "exec", command, cwd, root: ROOT });

  test("denies destructive commands, force pushes, and publishes by default", () => {
    for (const command of [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf ..",
      "rm -fr /",
      "rm -r -f / ",
      "sudo rm -rf /*",
      "git push --force origin main",
      "git push -f",
      "git push origin +main",
      "git push origin --delete feature",
      "npm publish",
      "bun publish --access public",
      "pnpm publish",
      "cargo publish",
      "gem push x.gem",
      "twine upload dist/*",
      "docker push ghcr.io/x/y",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      "shutdown -h now",
      ":(){ :|:& };:",
    ]) {
      const decision = exec(command);
      expect(decision.allow, command).toBe(false);
    }
  });

  test("allows everyday commands", () => {
    for (const command of [
      "rm -rf node_modules",
      "rm -rf dist/ .turbo",
      "git push origin feature/x",
      "git push",
      "npm test",
      "bun run build",
      "ls -la",
      "cat README.md | head",
      "echo shutdown-notice",
    ]) {
      expect(exec(command).allow, command).toBe(true);
    }
  });

  test("exec stays inside the projects root unless the policy says anywhere", () => {
    expect(exec("ls", "/").allow).toBe(false);
    expect(exec("ls", "/data/projects-other").allow).toBe(false);
    expect(exec("ls", ROOT).allow).toBe(true);
    expect(exec("ls", `${ROOT}/ws/p/src`).allow).toBe(true);
    const anywhere = runnerPolicy({ execAnywhere: true });
    expect(anywhere({ kind: "exec", command: "ls", cwd: "/", root: ROOT }).allow).toBe(true);
    expect(anywhere({ kind: "exec", command: "rm -rf /", cwd: "/", root: ROOT }).allow).toBe(false);
  });

  test("fs.write keeps its hands off .git; other dotfiles are fine", () => {
    expect(policy({ kind: "fs.write", project: P, path: ".git/config" }).allow).toBe(false);
    expect(policy({ kind: "fs.write", project: P, path: ".git/hooks/pre-commit" }).allow).toBe(
      false,
    );
    expect(policy({ kind: "fs.write", project: P, path: ".gitignore" }).allow).toBe(true);
    expect(policy({ kind: "fs.write", project: P, path: ".github/workflows/ci.yml" }).allow).toBe(
      true,
    );
    expect(policy({ kind: "fs.write", project: P, path: "src/.git-notes" }).allow).toBe(true);
    expect(policy({ kind: "fs.read", project: P, path: ".git/config" }).allow).toBe(true);
  });

  test("protected branches refuse pushes only when configured", () => {
    expect(policy({ kind: "git.push", project: P, branch: "main" }).allow).toBe(true);
    const guarded = runnerPolicy({ protectedBranches: ["main", "release"] });
    expect(guarded({ kind: "git.push", project: P, branch: "main" }).allow).toBe(false);
    expect(guarded({ kind: "git.push", project: P, branch: "feature" }).allow).toBe(true);
  });

  test("custom rules replace the defaults; enforce throws the policy code", () => {
    const custom = runnerPolicy({ deniedCommands: ["^curl\\b"], readOnlyPaths: ["package.json"] });
    expect(custom({ kind: "exec", command: "curl x", cwd: ROOT, root: ROOT }).allow).toBe(false);
    expect(custom({ kind: "exec", command: "rm -rf /", cwd: ROOT, root: ROOT }).allow).toBe(true);
    expect(custom({ kind: "fs.write", project: P, path: "package.json" }).allow).toBe(false);
    expect(custom({ kind: "fs.write", project: P, path: ".git/config" }).allow).toBe(true);
    expect(() =>
      enforce(custom, { kind: "exec", command: "curl x", cwd: ROOT, root: ROOT }),
    ).toThrow(PolicyDenied);
    try {
      enforce(custom, { kind: "exec", command: "curl x", cwd: ROOT, root: ROOT });
    } catch (error) {
      expect((error as PolicyDenied).code).toBe(-32451);
      expect((error as PolicyDenied).message).toMatch(/^policy denied: /);
    }
  });
});
