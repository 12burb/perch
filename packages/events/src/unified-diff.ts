/**
 * Unified diffs as data (task 1.13): a multi-file `git diff` splits into FileDiffs, a file's patch
 * splits into hunks, and a subset of hunks becomes a patch of its own that `git apply` (forward or
 * `--reverse`) accepts. Pure string work shared by the runner (which produces diffs), the api
 * (which selects hunks to reject), and the web (which shows them).
 */
import type { FileDiff } from "./engine.ts";

export type DiffHunk = {
  /** The `@@ -a,b +c,d @@ …` line as written. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Body lines with their prefix (` `, `+`, `-`, or `\` for "No newline at end of file"). */
  lines: string[];
};

export type ParsedPatch = {
  /** Everything before the first hunk: `diff --git`, `index`, `---`, `+++`, mode and rename lines. */
  preamble: string[];
  hunks: DiffHunk[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A single file's patch as its preamble and hunks. */
export function parseHunks(patch: string): ParsedPatch {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const preamble: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of lines) {
    const match = HUNK.exec(line);
    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, hunks };
}

/** The patch made of a file's preamble and the hunks at `indexes` (0-based), ready for `git apply`. */
export function selectHunks(patch: string, indexes: readonly number[]): string {
  const parsed = parseHunks(patch);
  const chosen = [...new Set(indexes)]
    .sort((a, b) => a - b)
    .map((index) => parsed.hunks[index])
    .filter((hunk): hunk is DiffHunk => hunk !== undefined);
  if (chosen.length === 0) return "";
  const lines = [...parsed.preamble];
  for (const hunk of chosen) lines.push(hunk.header, ...hunk.lines);
  return `${lines.join("\n")}\n`;
}

function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

/** `a/path` → `path` for the `---`/`+++` lines; `/dev/null` stays. */
function stripPrefix(raw: string): string {
  const path = unquote(raw.trim());
  return path === "/dev/null" ? path : path.replace(/^[ab]\//, "");
}

/**
 * Splits `git diff` output into one FileDiff per file: path (the new one; the old one for a
 * deletion), oldPath for renames, status, and +/- counts over the hunks. Binary files carry their
 * header lines as the patch and zero counts.
 */
export function splitPatches(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  const text = diff.endsWith("\n") ? diff : `${diff}\n`;
  const chunks = text.split(/^(?=diff --git )/m).filter((chunk) => chunk.trim().length > 0);
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    let oldName: string | null = null;
    let newName: string | null = null;
    let status: FileDiff["status"] | undefined;
    let renamedFrom: string | null = null;
    let renamedTo: string | null = null;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (inHunk) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        continue;
      }
      if (line.startsWith("--- ")) oldName = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ")) newName = stripPrefix(line.slice(4));
      else if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from "))
        renamedFrom = unquote(line.slice("rename from ".length));
      else if (line.startsWith("rename to ")) renamedTo = unquote(line.slice("rename to ".length));
    }
    let path: string;
    let oldPath: string | undefined;
    if (renamedFrom && renamedTo) {
      status = "renamed";
      path = renamedTo;
      oldPath = renamedFrom;
    } else if (newName && newName !== "/dev/null") {
      path = newName;
    } else if (oldName && oldName !== "/dev/null") {
      path = oldName;
    } else {
      // No ---/+++ lines (binary, mode-only): take the names from the diff --git line.
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? "");
      path = header?.[2] ?? header?.[1] ?? "";
      if (!path) continue;
    }
    if (!status) status = "modified";
    out.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      patch: chunk,
      additions,
      deletions,
      status,
    });
  }
  return out;
}
