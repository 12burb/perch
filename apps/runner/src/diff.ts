/**
 * A unified diff between two texts (task 1.9): what an ACP agent reports as a `diff` content block
 * (path, oldText, newText) becomes the spec's FileDiff (a patch with additions and deletions). A
 * plain LCS over lines; files here are source files, not gigabytes.
 */

export type UnifiedDiff = { patch: string; additions: number; deletions: number };

type Op = { kind: " " | "+" | "-"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Edit script between two line arrays (LCS by dynamic programming; O(n·m) memory, fine for source files). */
function edits(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "-", line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] as string });
  while (j < m) ops.push({ kind: "+", line: b[j++] as string });
  return ops;
}

/** A unified diff with `context` lines around each change (git's default of 3). */
export function unifiedDiff(
  path: string,
  oldText: string | null | undefined,
  newText: string,
  context = 3,
): UnifiedDiff {
  const before = splitLines(oldText ?? "");
  const after = splitLines(newText);
  const ops = edits(before, after);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === "+") additions++;
    else if (op.kind === "-") deletions++;
  }
  const header = `--- ${oldText == null ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n`;
  if (additions === 0 && deletions === 0) return { patch: "", additions, deletions };

  // Group changes into hunks separated by more than 2·context unchanged lines.
  const hunks: string[] = [];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  while (index < ops.length) {
    // skip to the next change
    while (index < ops.length && ops[index]?.kind === " ") {
      index++;
      oldLine++;
      newLine++;
    }
    if (index >= ops.length) break;
    const start = Math.max(0, index - context);
    const leading = index - start;
    let hunkOldStart = oldLine - leading;
    let hunkNewStart = newLine - leading;
    if (hunkOldStart < 1) hunkOldStart = 1;
    if (hunkNewStart < 1) hunkNewStart = 1;
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = start; k < index; k++) {
      lines.push(` ${ops[k]?.line ?? ""}`);
      oldCount++;
      newCount++;
    }
    // consume changes and trailing context, merging nearby changes
    let unchangedRun = 0;
    while (index < ops.length) {
      const op = ops[index] as Op;
      if (op.kind === " ") {
        unchangedRun++;
        if (unchangedRun > 2 * context) {
          // Close the hunk after `context` trailing lines: the current line is not pushed yet, so
          // the run has unchangedRun - 1 lines in the hunk; back the surplus out.
          const extra = unchangedRun - 1 - context;
          lines.splice(lines.length - extra, extra);
          oldCount -= extra;
          newCount -= extra;
          oldLine -= extra;
          newLine -= extra;
          index -= extra;
          break;
        }
        lines.push(` ${op.line}`);
        oldCount++;
        newCount++;
        oldLine++;
        newLine++;
        index++;
        continue;
      }
      unchangedRun = 0;
      lines.push(`${op.kind}${op.line}`);
      if (op.kind === "-") {
        oldCount++;
        oldLine++;
      } else {
        newCount++;
        newLine++;
      }
      index++;
    }
    // trailing context beyond the hunk end (when the file ended inside the unchanged run) is already included
    if (unchangedRun > context && unchangedRun <= 2 * context) {
      const extra = unchangedRun - context;
      lines.splice(lines.length - extra, extra);
      oldCount -= extra;
      newCount -= extra;
      oldLine -= extra;
      newLine -= extra;
      index -= extra;
    }
    hunks.push(
      `@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@\n${lines.join("\n")}\n`,
    );
  }
  return { patch: header + hunks.join(""), additions, deletions };
}
