import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/exec.ts";
import { PolicyDenied, runnerPolicy } from "../src/policy.ts";
import { projectDir } from "../src/projects.ts";

/** Task 1.5: exec runs one policy-checked shell command with a budget and capped output. */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000dd";
const ctx = { workspace_id: WS, user_id: USER, cap: "test" } as const;
const win = process.platform === "win32";

let root = "";
let dir = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "perch-exec-"));
  dir = projectDir(root, WS, PROJECT);
  mkdirSync(dir, { recursive: true });
});
// Windows releases a directory a killed child was using a moment later: retry the cleanup.
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe("exec (task 1.5)", () => {
  test("runs in the project, reports exit code, output, and timing", async () => {
    const opts = { root, policy: runnerPolicy() };
    const ok = await exec(opts, { ...ctx, command: "echo hi", cwd: dir, timeout: 10_000 });
    expect(ok.stdout.trim()).toBe("hi");
    expect(ok).toMatchObject({ exitCode: 0, stderr: "", timedOut: false });
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);

    const failed = await exec(opts, {
      ...ctx,
      command: win ? "echo oops 1>&2 & exit 3" : "echo oops >&2; exit 3",
      cwd: dir,
      timeout: 10_000,
    });
    expect(failed.exitCode).toBe(3);
    expect(failed.stderr.trim()).toBe("oops");

    // cwd is relative to the projects root when not absolute.
    const relative = await exec(opts, {
      ...ctx,
      command: "echo rel",
      cwd: `${WS}/${PROJECT}`,
      timeout: 10_000,
    });
    expect(relative.stdout.trim()).toBe("rel");
  });

  test("the runner's own secrets never reach a command (AGENTS.md §1.6)", async () => {
    const before = process.env.PERCH_RUNNER_TOKEN;
    process.env.PERCH_RUNNER_TOKEN = "prt_leaked";
    try {
      const result = await exec(
        { root, policy: runnerPolicy() },
        {
          ...ctx,
          command: win ? "echo tok=[%PERCH_RUNNER_TOKEN%]" : "echo tok=[$PERCH_RUNNER_TOKEN]",
          cwd: dir,
          timeout: 10_000,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("tok=[");
      expect(result.stdout).not.toContain("prt_leaked");
      // Blanked, not dropped (ADR-0160): a POSIX shell expands it to nothing.
      if (!win) expect(result.stdout.trim()).toBe("tok=[]");
    } finally {
      if (before === undefined) delete process.env.PERCH_RUNNER_TOKEN;
      else process.env.PERCH_RUNNER_TOKEN = before;
    }
  });

  test("a project instead of a cwd runs in that project's directory (task 3.18)", async () => {
    const opts = { root, policy: runnerPolicy() };
    // The testing loop names the project rather than the directory: where a project lives is the
    // runner's business, and an api that has to know is an api that has to agree with it.
    const named = await exec(opts, {
      ...ctx,
      command: win ? "cd" : "pwd",
      project: PROJECT,
      timeout: 10_000,
    });
    expect(named.exitCode).toBe(0);
    expect(named.stdout.trim().replace(/\\/g, "/")).toContain(`${WS}/${PROJECT}`);

    // A cwd still wins when both are given: it is the more specific of the two.
    mkdirSync(join(dir, "inner"), { recursive: true });
    const both = await exec(opts, {
      ...ctx,
      command: win ? "cd" : "pwd",
      cwd: join(dir, "inner"),
      project: PROJECT,
      timeout: 10_000,
    });
    expect(both.stdout.trim().replace(/\\/g, "/")).toContain("/inner");
  });

  test("a command over its budget is killed and reported", async () => {
    const opts = { root, policy: runnerPolicy() };
    const slow = await exec(opts, {
      ...ctx,
      command: win ? "ping -n 10 127.0.0.1 > NUL" : "sleep 5.31",
      cwd: dir,
      timeout: 200,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBeNull();
    expect(slow.durationMs).toBeLessThan(5_000);
    // The whole tree is gone: nothing keeps the project directory busy (Windows) or runs on.
    if (process.platform !== "win32") {
      await Bun.sleep(100);
      // Only a real `sleep 5.31` process counts (not shells whose command line quotes it).
      const lingering = Bun.spawnSync([
        "sh",
        "-c",
        "ps -eo comm=,args= | grep '^sleep ' | grep '5.31' || true",
      ])
        .stdout.toString()
        .trim();
      expect(lingering).toBe("");
    }
  });

  test("the policy hook refuses denied commands and directories outside the projects root", async () => {
    const opts = { root, policy: runnerPolicy() };
    await expect(
      exec(opts, { ...ctx, command: "rm -rf /", cwd: dir, timeout: 1_000 }),
    ).rejects.toThrow(PolicyDenied);
    await expect(
      exec(opts, { ...ctx, command: "echo hi", cwd: tmpdir(), timeout: 1_000 }),
    ).rejects.toThrow(PolicyDenied);
    const anywhere = { root, policy: runnerPolicy({ execAnywhere: true }) };
    const out = await exec(anywhere, {
      ...ctx,
      command: "echo hi",
      cwd: tmpdir(),
      timeout: 10_000,
    });
    expect(out.stdout.trim()).toBe("hi");
    await expect(
      exec(opts, { ...ctx, command: "echo hi", cwd: join(dir, "missing"), timeout: 1_000 }),
    ).rejects.toThrow(/cwd does not exist/);
  });

  test("output is capped", async () => {
    const opts = { root, policy: runnerPolicy(), maxOutputBytes: 100 };
    const big = await exec(opts, {
      ...ctx,
      command: win ? "for /L %i in (1,1,50) do @echo 0123456789" : "yes 0123456789 | head -n 50",
      cwd: dir,
      timeout: 10_000,
    });
    expect(big.stdout.length).toBeLessThan(140);
    expect(big.stdout).toContain("[truncated]");
  });
});
