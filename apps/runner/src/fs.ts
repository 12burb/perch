/**
 * fs.* on a runner (spec §7.6, task 1.5): list, read, write, stat, and search inside a project, every
 * path resolved inside the project directory, every call through the policy hook. Search is ripgrep
 * (`rg --json`) when the machine has it (the runner image does) and a walk in-process otherwise.
 */
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { RunnerRequestParams } from "@perch/events";
import { childEnv } from "./env.ts";
import type { Notify } from "./notify.ts";
import { enforce, type RunnerPolicy } from "./policy.ts";
import { projectDir, resolveInside } from "./projects.ts";

export type FsOptions = {
  root: string;
  policy: RunnerPolicy;
  notify?: Notify;
  /** fs.read returns at most this many bytes (default 2 MiB) and says so. */
  maxReadBytes?: number;
  /** fs.search stops after this many matches unless the request says otherwise (default 500). */
  searchLimit?: number;
};

type Entry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
};

function typeOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (stats.isSymbolicLink()) return "symlink" as const;
  if (stats.isDirectory()) return "dir" as const;
  if (stats.isFile()) return "file" as const;
  return "other" as const;
}

function dirOf(options: FsOptions, params: { workspace_id: string; project: string }): string {
  const dir = projectDir(options.root, params.workspace_id, params.project);
  if (!existsSync(dir)) throw new Error("project directory does not exist on this runner");
  return dir;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export async function fsList(
  options: FsOptions,
  params: RunnerRequestParams<"fs.list">,
): Promise<{ entries: Entry[] }> {
  const dir = dirOf(options, params);
  enforce(options.policy, { kind: "fs.list", project: params.project, path: params.path });
  const target = resolveInside(dir, params.path || ".");
  const entries: Entry[] = [];
  for (const dirent of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, dirent.name);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    entries.push({
      name: dirent.name,
      type: typeOf(stats),
      size: stats.isFile() ? stats.size : 0,
      mtime: stats.mtime.toISOString(),
    });
  }
  entries.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "dir"
        ? -1
        : b.type === "dir"
          ? 1
          : 0,
  );
  return { entries };
}

const BINARY_PROBE = 8000;

function looksBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, BINARY_PROBE);
  return probe.includes(0);
}

export async function fsRead(
  options: FsOptions,
  params: RunnerRequestParams<"fs.read">,
): Promise<{ content: string; encoding: "utf8" | "base64"; size: number; truncated: boolean }> {
  const dir = dirOf(options, params);
  enforce(options.policy, { kind: "fs.read", project: params.project, path: params.path });
  const target = resolveInside(dir, params.path);
  const stats = statSync(target);
  if (!stats.isFile()) throw new Error(`${params.path} is not a file`);
  const max = options.maxReadBytes ?? 2 * 1024 * 1024;
  const whole = readFileSync(target);
  const bytes = whole.length > max ? whole.subarray(0, max) : whole;
  if (looksBinary(bytes)) {
    return {
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      size: stats.size,
      truncated: whole.length > max,
    };
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { content, encoding: "utf8", size: stats.size, truncated: whole.length > max };
  } catch {
    return {
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      size: stats.size,
      truncated: whole.length > max,
    };
  }
}

export async function fsWrite(
  options: FsOptions,
  params: RunnerRequestParams<"fs.write">,
): Promise<{ bytes: number }> {
  const dir = dirOf(options, params);
  const target = resolveInside(dir, params.path);
  const relPath = toPosix(relative(dir, target));
  enforce(options.policy, { kind: "fs.write", project: params.project, path: relPath });
  const existed = existsSync(target);
  await mkdir(dirname(target), { recursive: true });
  const bytes =
    params.encoding === "base64"
      ? Buffer.from(params.content, "base64")
      : Buffer.from(params.content, "utf8");
  writeFileSync(target, bytes);
  options.notify?.({
    method: "fs.changed",
    params: { project: params.project, paths: [relPath], kind: existed ? "change" : "create" },
  });
  return { bytes: bytes.length };
}

export async function fsStat(
  options: FsOptions,
  params: RunnerRequestParams<"fs.stat">,
): Promise<{ exists: boolean; type?: Entry["type"]; size?: number; mtime?: string }> {
  const dir = dirOf(options, params);
  enforce(options.policy, { kind: "fs.stat", project: params.project, path: params.path });
  const target = resolveInside(dir, params.path || ".");
  try {
    const stats = lstatSync(target);
    return {
      exists: true,
      type: typeOf(stats),
      size: stats.isFile() ? stats.size : 0,
      mtime: stats.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
}

export type SearchMatch = { path: string; line: number; column: number; text: string };
export type SearchResult = {
  matches: SearchMatch[];
  truncated: boolean;
  tookMs: number;
  engine: "ripgrep" | "builtin";
};

let ripgrepPath: string | null | undefined;
/** Where ripgrep is, once; null when the machine has none. */
export function ripgrep(): string | null {
  if (ripgrepPath === undefined) ripgrepPath = Bun.which("rg");
  return ripgrepPath;
}

type RgMatch = {
  type: string;
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number | null;
    submatches: { start: number }[];
  };
};

async function searchWithRipgrep(
  rg: string,
  dir: string,
  params: RunnerRequestParams<"fs.search">,
  limit: number,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const args = [
    "--json",
    "--no-messages",
    "--max-columns",
    "500",
    "--max-columns-preview",
    params.regex ? "--regexp" : "--fixed-strings",
    params.query,
  ];
  if (params.ignoreCase) args.push("--ignore-case");
  else args.push("--smart-case");
  if (params.glob) args.push("--glob", params.glob);
  // rg stops early on its own once every file has produced its matches; we cut at the limit.
  args.push("--max-count", String(limit), "--", ".");
  const proc = Bun.spawn([rg, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "ignore",
    env: childEnv(),
  });
  const matches: SearchMatch[] = [];
  let truncated = false;
  const decoder = new TextDecoder();
  let buffered = "";
  const consume = (line: string) => {
    if (!line) return;
    let message: RgMatch;
    try {
      message = JSON.parse(line) as RgMatch;
    } catch {
      return;
    }
    if (message.type !== "match") return;
    const path = message.data.path.text ?? "";
    const text = (message.data.lines.text ?? "").replace(/\r?\n$/, "");
    const first = message.data.submatches[0];
    matches.push({
      path: toPosix(path.replace(/^\.[\\/]/, "")),
      line: message.data.line_number ?? 0,
      column: (first?.start ?? 0) + 1,
      text,
    });
  };
  const reader = proc.stdout.getReader();
  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      consume(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (matches.length >= limit) {
        truncated = true;
        proc.kill();
        break outer;
      }
      newline = buffered.indexOf("\n");
    }
  }
  if (!truncated) consume(buffered);
  await proc.exited;
  return { matches: sortMatches(matches.slice(0, limit)), truncated };
}

/** ripgrep walks in parallel and the builtin walks in directory order: both answer sorted. */
function sortMatches(matches: SearchMatch[]): SearchMatch[] {
  return matches.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
}

const SKIPPED_DIRS = new Set([".git", "node_modules", ".perch-worktrees"]);

function walk(dir: string, base: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), base, out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
}

export function searchBuiltin(
  dir: string,
  params: RunnerRequestParams<"fs.search">,
  limit: number,
): { matches: SearchMatch[]; truncated: boolean } {
  const flags =
    params.ignoreCase || (!params.regex && params.query === params.query.toLowerCase()) ? "i" : "";
  const pattern = params.regex
    ? new RegExp(params.query, flags)
    : new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  const glob = params.glob ? new Bun.Glob(params.glob) : null;
  const files: string[] = [];
  walk(dir, dir, files);
  const matches: SearchMatch[] = [];
  for (const file of files) {
    const rel = toPosix(relative(dir, file));
    if (glob && !glob.match(rel) && !glob.match(file.slice(file.lastIndexOf(sep) + 1))) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    if (looksBinary(bytes)) continue;
    const lines = bytes.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? "";
      const found = pattern.exec(text);
      if (!found) continue;
      matches.push({
        path: rel,
        line: i + 1,
        column: found.index + 1,
        text: text.replace(/\r$/, ""),
      });
      if (matches.length >= limit) return { matches: sortMatches(matches), truncated: true };
    }
  }
  return { matches: sortMatches(matches), truncated: false };
}

export async function fsSearch(
  options: FsOptions,
  params: RunnerRequestParams<"fs.search">,
): Promise<SearchResult> {
  const dir = dirOf(options, params);
  enforce(options.policy, { kind: "fs.search", project: params.project, path: "." });
  if (!params.query) return { matches: [], truncated: false, tookMs: 0, engine: "builtin" };
  const limit = params.limit ?? options.searchLimit ?? 500;
  const started = performance.now();
  const rg = ripgrep();
  const result = rg
    ? await searchWithRipgrep(rg, dir, params, limit)
    : searchBuiltin(dir, params, limit);
  return {
    ...result,
    tookMs: Math.round(performance.now() - started),
    engine: rg ? "ripgrep" : "builtin",
  };
}
