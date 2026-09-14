import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { defaultHandlers, implementedMethods } from "../src/handlers.ts";
import {
  cloneEnv,
  gitAuth,
  projectDir,
  projectsRoot,
  readProjectFiles,
  removeProject,
  resolveInside,
  scrubUrl,
  setupProject,
  writeProjectFile,
} from "../src/projects.ts";

/**
 * Task 1.4: a project on a runner is a directory created empty, from a clone, or from uploads;
 * the runner reads .perch/project.json and devcontainer.json back and runs postCreateCommand.
 * Clone credentials reach git through its credential helper or GIT_SSH_COMMAND, never argv.
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000dd";
const ctx = { workspace_id: WS, user_id: USER, cap: "test", project: PROJECT } as const;

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository to clone from, with a config file, a JSONC devcontainer, and a postCreateCommand. */
async function upstream(): Promise<string> {
  const dir = tmp("perch-upstream-");
  const git = simpleGit({ baseDir: dir });
  await git.init(["--initial-branch", "trunk"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Perch tests");
  mkdirSync(join(dir, ".perch"), { recursive: true });
  mkdirSync(join(dir, ".devcontainer"), { recursive: true });
  writeFileSync(
    join(dir, ".perch", "project.json"),
    JSON.stringify({ name: "hello", engine: "codex" }),
  );
  writeFileSync(
    join(dir, ".devcontainer", "devcontainer.json"),
    `{
  // JSONC: comments and a trailing comma are allowed here
  "name": "hello",
  "postCreateCommand": "echo created > created.txt",
}
`,
  );
  writeFileSync(join(dir, "README.md"), "# hello\n");
  await git.add(".");
  await git.commit("initial");
  return dir;
}

describe("projects on a runner", () => {
  test("projects live under PERCH_PROJECTS_DIR, else /data/projects, one directory per project", () => {
    expect(projectsRoot({})).toBe("/data/projects");
    expect(projectsRoot({ PERCH_PROJECTS_DIR: "/srv/p" })).toBe("/srv/p");
    expect(projectDir("/srv/p", WS, PROJECT)).toBe(join("/srv/p", WS, PROJECT));
  });

  test("resolveInside keeps paths in the project and refuses escapes", () => {
    const dir = join(tmpdir(), "proj");
    expect(resolveInside(dir, "src/index.ts")).toBe(join(dir, "src", "index.ts"));
    expect(resolveInside(dir, "./a/../b")).toBe(join(dir, "b"));
    expect(() => resolveInside(dir, "../secret")).toThrow(/escapes/);
    expect(() => resolveInside(dir, "a/../../secret")).toThrow(/escapes/);
    expect(() => resolveInside(dir, "/etc/passwd")).toThrow(/escapes/);
  });

  test("a token goes through git's credential helper via the environment, never the command line", () => {
    const auth = gitAuth({ kind: "token", token: "ghp_secret" });
    expect(auth.config.join("\n")).not.toContain("ghp_secret");
    expect(auth.config[0]).toMatch(/^credential\.helper=/);
    expect(auth.env.PERCH_GIT_SECRET).toBe("ghp_secret");
    expect(auth.env.PERCH_GIT_USERNAME).toBe("x-access-token");
    expect(auth.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitAuth({ kind: "token", username: "oauth2", token: "t" }).env.PERCH_GIT_USERNAME).toBe(
      "oauth2",
    );
  });

  test("a deploy key goes through GIT_SSH_COMMAND with a key file and no prompts", () => {
    const auth = gitAuth({ kind: "ssh", privateKey: "PRIVATE" }, "/tmp/k/id");
    expect(auth.env.GIT_SSH_COMMAND).toContain('-i "/tmp/k/id"');
    expect(auth.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(auth.env.GIT_SSH_COMMAND).not.toContain("PRIVATE");
    expect(() => gitAuth({ kind: "ssh", privateKey: "PRIVATE" })).toThrow(/key file/);
    expect(gitAuth(undefined)).toEqual({ config: [], env: {} });
  });

  test("git never inherits the host's askpass, ssh, or config overrides", () => {
    const env = cloneEnv(
      {
        PATH: "/bin",
        HOME: "/home/x",
        GIT_ASKPASS: "/evil",
        SSH_ASKPASS: "/evil",
        GIT_SSH_COMMAND: "evil",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_DIR: "/elsewhere",
        UNSET: undefined,
      },
      { PERCH_GIT_SECRET: "t" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/x",
      GIT_TERMINAL_PROMPT: "0",
      PERCH_GIT_SECRET: "t",
    });
    expect(scrubUrl("fatal: unable to access 'https://u:tok@example.com/r.git/'")).toBe(
      "fatal: unable to access 'https://***@example.com/r.git/'",
    );
    expect(scrubUrl("ssh://git@example.com/r.git")).toBe("ssh://***@example.com/r.git");
  });

  test("readProjectFiles reads JSON config and JSONC devcontainer, and reports parse errors", async () => {
    const dir = tmp("perch-files-");
    expect(await readProjectFiles(dir)).toEqual({ config: null, devcontainer: null });
    mkdirSync(join(dir, ".perch"));
    writeFileSync(join(dir, ".perch", "project.json"), "{ not json");
    writeFileSync(join(dir, ".devcontainer.json"), '{ "image": "x" /* c */ }');
    const files = await readProjectFiles(dir);
    expect(files.config).toBeNull();
    expect(files.configError).toMatch(/^\.perch\/project\.json: /);
    expect(files.devcontainer).toEqual({ image: "x" });
    expect(files.devcontainerError).toBeUndefined();
  });

  test("an empty project is a fresh repository on the requested default branch", async () => {
    const root = tmp("perch-projects-");
    const result = await setupProject(
      { root },
      { ...ctx, source: { kind: "empty", defaultBranch: "develop" } },
    );
    expect(result.path).toBe(projectDir(root, WS, PROJECT));
    expect(existsSync(join(result.path, ".git"))).toBe(true);
    expect(result.defaultBranch).toBe("develop");
    expect(result.head).toBeNull();
    expect(result.config).toBeNull();
    expect(result.postCreate).toBeUndefined();
  });

  test("a clone brings the files, reads both config files, and runs postCreateCommand", async () => {
    const root = tmp("perch-projects-");
    const source = await upstream();
    const result = await setupProject(
      { root, postCreateTimeoutMs: 30_000 },
      { ...ctx, source: { kind: "clone", url: source } },
    );
    // git on Windows may check out with CRLF (core.autocrlf); the content is what matters.
    expect(readFileSync(join(result.path, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "# hello\n",
    );
    expect(result.defaultBranch).toBe("trunk");
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.config).toEqual({ name: "hello", engine: "codex" });
    expect(result.devcontainer).toMatchObject({ name: "hello" });
    expect(result.postCreate?.exitCode).toBe(0);
    expect(readFileSync(join(result.path, "created.txt"), "utf8").trim()).toBe("created");
  });

  test("postCreate: false skips the command; a failing command is reported, not thrown", async () => {
    const root = tmp("perch-projects-");
    const source = await upstream();
    const skipped = await setupProject(
      { root },
      { ...ctx, source: { kind: "clone", url: source }, postCreate: false },
    );
    expect(skipped.postCreate).toBeUndefined();
    expect(existsSync(join(skipped.path, "created.txt"))).toBe(false);

    const git = simpleGit({ baseDir: source });
    writeFileSync(
      join(source, ".devcontainer", "devcontainer.json"),
      '{ "postCreateCommand": ["sh", "-c", "echo boom >&2; exit 3"] }',
    );
    await git.add(".");
    await git.commit("break post create");
    const failed = await setupProject({ root }, { ...ctx, source: { kind: "clone", url: source } });
    expect(failed.postCreate?.exitCode).toBe(3);
    expect(failed.postCreate?.output).toContain("boom");
  });

  test("a clone of a missing repository fails with git's message and leaves no directory", async () => {
    const root = tmp("perch-projects-");
    await expect(
      setupProject({ root }, { ...ctx, source: { kind: "clone", url: join(root, "nope.git") } }),
    ).rejects.toThrow();
    expect(existsSync(projectDir(root, WS, PROJECT))).toBe(false);
  });

  test("uploads write utf8 or base64 content inside the project only", async () => {
    const root = tmp("perch-projects-");
    await setupProject({ root }, { ...ctx, source: { kind: "upload" } });
    expect(await writeProjectFile({ root }, { ...ctx, path: "src/a.txt", content: "hi" })).toEqual({
      bytes: 2,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeProjectFile(
      { root },
      { ...ctx, path: "img.png", content: png.toString("base64"), encoding: "base64" },
    );
    const dir = projectDir(root, WS, PROJECT);
    expect(readFileSync(join(dir, "src", "a.txt"), "utf8")).toBe("hi");
    expect(readFileSync(join(dir, "img.png"))).toEqual(png);
    await expect(
      writeProjectFile({ root }, { ...ctx, path: "../outside.txt", content: "x" }),
    ).rejects.toThrow(/escapes/);
    await expect(
      writeProjectFile(
        { root },
        { ...ctx, project: "0190f2d0-0000-7000-8000-0000000000ee", path: "a", content: "x" },
      ),
    ).rejects.toThrow(/does not exist/);
  });

  test("removeProject deletes the directory and says whether there was one", async () => {
    const root = tmp("perch-projects-");
    await setupProject({ root }, { ...ctx, source: { kind: "empty" } });
    expect(await removeProject({ root }, ctx)).toEqual({ removed: true });
    expect(existsSync(projectDir(root, WS, PROJECT))).toBe(false);
    expect(await removeProject({ root }, ctx)).toEqual({ removed: false });
  });

  test("the default handlers implement project.setup, project.remove, and fs.write", () => {
    const methods = implementedMethods(defaultHandlers({ projects: { root: "/x" } }));
    expect(methods).toEqual(
      expect.arrayContaining(["ports.list", "project.setup", "project.remove", "fs.write"]),
    );
  });
});
