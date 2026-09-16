/**
 * Direct tweaks, written to source (spec §5.6 "Direct tweaks (Phase 3): edit text, classes, common
 * CSS in the panel → applied instantly → written to source via a deterministic apply_element_edit
 * tool → diff card"; task 3.21).
 *
 * The panel has already applied the tweak in the preview — that is what "instantly" means, and it
 * happens in the page without asking anybody. This is the other half: making it true in the
 * repository. The edit itself is a pure function over the file (`@perch/inspector`'s
 * `applyElementEdit`) and everything here is the plumbing around it: read the file through the
 * runner, ask, write it back, and say what changed.
 *
 * It is the same path whether a person pressed Apply in the panel or an agent called the tool, and
 * it goes through the same policy hook a session's own write does.
 */

import type { Project } from "@perch/db";
import { fsReadResultSchema, type RunnerLink } from "@perch/events";
import { applyElementEdit, type ElementEdit, parseSource } from "@perch/inspector";
import { PerchError } from "../errors.ts";
import { runnerCall } from "./runners.ts";

export type ElementEditInput = {
  project: Project;
  link: RunnerLink;
  userId: string;
  /** `data-perch-src` exactly as the element carries it: `src/app.tsx:42:7`. */
  source: string;
  edit: ElementEdit;
};

export type ElementEditResult = {
  path: string;
  changed: ("className" | "text")[];
  /** A unified diff of the one file, so the caller can show a diff card without asking again. */
  diff: string;
};

/** One element, changed in the file it was written in. */
export async function editElement(input: ElementEditInput): Promise<ElementEditResult> {
  const where = parseSource(input.source);
  if (!where) {
    throw PerchError.validation("that element does not say where it came from", {
      source: input.source,
    });
  }
  const ctx = {
    workspace_id: input.project.workspaceId,
    user_id: input.userId,
    project: input.project.id,
  };

  const raw = await runnerCall(input.link, "fs.read", { ...ctx, path: where.file });
  const read = fsReadResultSchema.parse(raw);
  if (read.encoding !== "utf8") {
    throw PerchError.validation(`${where.file} is not text, so there is nothing to edit`);
  }
  if (read.truncated) {
    throw PerchError.validation(`${where.file} is too big to edit this way`);
  }

  const result = applyElementEdit(read.content, where.at, input.edit);
  if (!result.ok) {
    // The reason is the useful part: it is what the panel shows instead of the tweak, and what
    // tells an agent to go and edit the file itself.
    throw PerchError.validation(result.reason, { path: where.file, source: input.source });
  }

  await runnerCall(input.link, "fs.write", {
    ...ctx,
    path: where.file,
    content: result.code,
    encoding: "utf8",
  });

  return {
    path: where.file,
    changed: result.changed,
    diff: unified(where.file, read.content, result.code),
  };
}

/**
 * A unified diff of one file, made here rather than asked of git: the working tree may have other
 * changes in it, and what this card is about is the one edit that was just made.
 */
export function unified(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // The first and last lines that differ, with three lines of context around them — enough for a
  // card, and the file is on disk for anybody who wants the rest.
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first += 1;
  let lastA = a.length - 1;
  let lastB = b.length - 1;
  while (lastA > first && lastB > first && a[lastA] === b[lastB]) {
    lastA -= 1;
    lastB -= 1;
  }
  const from = Math.max(0, first - 3);
  const toA = Math.min(a.length - 1, lastA + 3);
  const toB = Math.min(b.length - 1, lastB + 3);

  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`,
  ];
  for (let i = from; i < first; i += 1) lines.push(` ${a[i] ?? ""}`);
  for (let i = first; i <= lastA; i += 1) lines.push(`-${a[i] ?? ""}`);
  for (let i = first; i <= lastB; i += 1) lines.push(`+${b[i] ?? ""}`);
  for (let i = lastA + 1; i <= toA; i += 1) lines.push(` ${a[i] ?? ""}`);
  return `${lines.join("\n")}\n`;
}
