import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerNotification } from "@perch/events";
import { fsList, fsRead, fsSearch, fsStat, fsWrite, ripgrep, searchBuiltin } from "../src/fs.ts";
import { PolicyDenied, runnerPolicy } from "../src/policy.ts";
import { projectDir } from "../src/projects.ts";

/**
 * Task 1.5: fs.list/read/write/stat/search inside a project, through the policy hook; search is
 * ripgrep when present and the built-in walk otherwise, with the same answers; and the acceptance
 * benchmark: fs.search under 200 ms on a 50k-file repository (asserted with ripgrep, the runner
 * image's engine; the built-in engine is checked for correctness only).
 */

const WS = "0190f2d0-0000-7000-8000-000000000001";
const USER = "0190f2d0-0000-7000-8000-0000000000aa";
const PROJECT = "0190f2d0-0000-7000-8000-0000000000dd";
const ctx = { workspace_id: WS, user_id: USER, cap: "test", project: PROJECT } as const;

let root = "";
let dir = "";
const notifications: RunnerNotification[] = [];
const options = () => ({
  root,
  policy: runnerPolicy(),
  notify: (n: RunnerNotification) => notifications.push(n),
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "perch-fs-"));
  dir = projectDir(root, WS, PROJECT);
  mkdirSync(join(dir, "src", "util"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Title\nhello world\nHello again\n");
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1; // hello\n");
  writeFileSync(join(dir, "src", "util", "helpers.ts"), "export function world() {}\n");
  writeFileSync(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));
  writeFileSync(join(dir, ".git", "config"), "[core]\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fs methods (task 1.5)", () => {
  test("list: directories first, then files, with types and sizes", async () => {
    const { entries } = await fsList(options(), { ...ctx, path: "" });
    // Directories first, then files, each group case-insensitively (as file trees show them).
    expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      "dir:.git",
      "dir:src",
      "file:img.png",
      "file:README.md",
    ]);
    const readme = entries.find((e) => e.name === "README.md");
    expect(readme?.size).toBe(Buffer.byteLength("# Title\nhello world\nHello again\n"));
    expect(readme?.mtime).toMatch(/^\d{4}-/);
    const nested = await fsList(options(), { ...ctx, path: "src/util" });
    expect(nested.entries.map((e) => e.name)).toEqual(["helpers.ts"]);
    await expect(fsList(options(), { ...ctx, path: "../" })).rejects.toThrow(/escapes/);
  });

  test("read: text as utf8, binary as base64, big files truncated, directories refused", async () => {
    const text = await fsRead(options(), { ...ctx, path: "README.md" });
    expect(text).toEqual({
      content: "# Title\nhello world\nHello again\n",
      encoding: "utf8",
      size: 32,
      truncated: false,
    });
    const binary = await fsRead(options(), { ...ctx, path: "img.png" });
    expect(binary.encoding).toBe("base64");
    expect(Buffer.from(binary.content, "base64")[0]).toBe(0x89);
    const cut = await fsRead({ ...options(), maxReadBytes: 8 }, { ...ctx, path: "README.md" });
    expect(cut).toEqual({ content: "# Title\n", encoding: "utf8", size: 32, truncated: true });
    await expect(fsRead(options(), { ...ctx, path: "src" })).rejects.toThrow(/not a file/);
    await expect(fsRead(options(), { ...ctx, path: "missing.txt" })).rejects.toThrow();
  });

  test("write: creates and changes files, notifies fs.changed, respects read-only paths", async () => {
    notifications.length = 0;
    expect(await fsWrite(options(), { ...ctx, path: "notes/todo.md", content: "- a\n" })).toEqual({
      bytes: 4,
    });
    expect(
      await fsWrite(options(), { ...ctx, path: "notes/todo.md", content: "- a\n- b\n" }),
    ).toEqual({
      bytes: 8,
    });
    expect(readFileSync(join(dir, "notes", "todo.md"), "utf8")).toBe("- a\n- b\n");
    expect(notifications).toEqual([
      {
        method: "fs.changed",
        params: { project: PROJECT, paths: ["notes/todo.md"], kind: "create" },
      },
      {
        method: "fs.changed",
        params: { project: PROJECT, paths: ["notes/todo.md"], kind: "change" },
      },
    ]);
    await expect(
      fsWrite(options(), { ...ctx, path: ".git/config", content: "[core]\n\tbad = true\n" }),
    ).rejects.toThrow(PolicyDenied);
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).toBe("[core]\n");
    await expect(fsWrite(options(), { ...ctx, path: "../x", content: "" })).rejects.toThrow(
      /escapes/,
    );
  });

  test("stat: what is there, and that something is not", async () => {
    expect(await fsStat(options(), { ...ctx, path: "src" })).toMatchObject({
      exists: true,
      type: "dir",
    });
    expect(await fsStat(options(), { ...ctx, path: "README.md" })).toMatchObject({
      exists: true,
      type: "file",
      size: 32,
    });
    expect(await fsStat(options(), { ...ctx, path: "nope" })).toEqual({ exists: false });
  });

  test("search: literal by default, regex on request, globs, case, limits, both engines agree", async () => {
    // Smart case: an all-lowercase query matches any case; a capital makes it exact.
    const hello = await fsSearch(options(), { ...ctx, query: "hello" });
    expect(hello.matches).toEqual([
      { path: "README.md", line: 2, column: 1, text: "hello world" },
      { path: "README.md", line: 3, column: 1, text: "Hello again" },
      { path: "src/index.ts", line: 1, column: 24, text: "export const x = 1; // hello" },
    ]);
    expect(hello.truncated).toBe(false);
    expect(hello.engine).toBe(ripgrep() ? "ripgrep" : "builtin");

    const insensitive = await fsSearch(options(), { ...ctx, query: "HELLO", ignoreCase: true });
    expect(insensitive.matches).toEqual(hello.matches);
    const smartCase = await fsSearch(options(), { ...ctx, query: "Hello" });
    expect(smartCase.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["README.md:3"]);

    const glob = await fsSearch(options(), { ...ctx, query: "hello", glob: "*.ts" });
    expect(glob.matches.map((m) => m.path)).toEqual(["src/index.ts"]);

    const regex = await fsSearch(options(), { ...ctx, query: "wor.d", regex: true });
    expect(regex.matches.map((m) => `${m.path}:${m.line}:${m.column}`)).toEqual([
      "README.md:2:7",
      "src/util/helpers.ts:1:17",
    ]);
    const literalDot = await fsSearch(options(), { ...ctx, query: "wor.d" });
    expect(literalDot.matches).toEqual([]);

    const limited = await fsSearch(options(), {
      ...ctx,
      query: "hello",
      ignoreCase: true,
      limit: 2,
    });
    expect(limited.matches.length).toBe(2);
    expect(limited.truncated).toBe(true);

    // The built-in engine answers the same as ripgrep (the fallback for machines without rg).
    const builtin = searchBuiltin(dir, { ...ctx, query: "hello" }, 500);
    expect(builtin.matches).toEqual(hello.matches);
    expect(searchBuiltin(dir, { ...ctx, query: "Hello" }, 500).matches).toEqual(smartCase.matches);
    expect(searchBuiltin(dir, { ...ctx, query: "wor.d", regex: true }, 500).matches).toEqual(
      regex.matches,
    );
    expect(await fsSearch(options(), { ...ctx, query: "" })).toMatchObject({ matches: [] });
  });

  test("acceptance: fs.search under 200 ms on a 50k-file repository", async () => {
    const bigRoot = mkdtempSync(join(tmpdir(), "perch-fs-bench-"));
    const bigProject = "0190f2d0-0000-7000-8000-0000000000ee";
    const big = projectDir(bigRoot, WS, bigProject);
    const dirs = 500;
    const perDir = 100;
    let needles = 0;
    for (let d = 0; d < dirs; d++) {
      const sub = join(big, "src", `module-${String(d).padStart(3, "0")}`);
      mkdirSync(sub, { recursive: true });
      for (let f = 0; f < perDir; f++) {
        const index = d * perDir + f;
        const needle = index % 2000 === 0 ? "perch_needle_42" : "plain";
        if (needle !== "plain") needles += 1;
        writeFileSync(
          join(sub, `file-${f}.ts`),
          `// file ${index}\nexport const value${f} = ${index};\nconst marker = "${needle}";\n`,
        );
      }
    }
    expect(needles).toBe(25);
    try {
      const opts = { root: bigRoot, policy: runnerPolicy() };
      const params = { ...ctx, project: bigProject, query: "perch_needle_42" };
      await fsSearch(opts, params); // warm the page cache once, as a second search on a repo would be
      const timings: number[] = [];
      let last = await fsSearch(opts, params);
      for (let i = 0; i < 3; i++) {
        last = await fsSearch(opts, params);
        timings.push(last.tookMs);
      }
      expect(last.matches.length).toBe(25);
      expect(last.truncated).toBe(false);
      const best = Math.min(...timings);
      console.log(`fs.search over 50,000 files: ${timings.join("/")} ms (${last.engine})`);
      if (last.engine === "ripgrep") expect(best).toBeLessThan(200);
    } finally {
      rmSync(bigRoot, { recursive: true, force: true });
    }
    expect(existsSync(bigRoot)).toBe(false);
  }, 240_000);
});
