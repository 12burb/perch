import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Ground rule: every user-facing string goes through `t("key")` (AGENTS.md §5), so a locale can
 * replace it. A placeholder or an ARIA label written as a literal is one nobody can translate and
 * nothing counts; this walk fails on the first one (ADR-0167).
 */

const root = resolve(import.meta.dir, "..", "..", "..");
const ROOTS = ["apps/web/src", "packages/ui/src"];
// A `${…}` inside quotes is a selector in a template string, not a label.
const LITERAL = /\b(?:placeholder|aria-label)="(?!\$\{)[^"]*"/g;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path));
    // A demo is a component test's fixture, not a screen.
    else if (entry.endsWith(".tsx") && !entry.endsWith(".demo.tsx")) out.push(path);
  }
  return out;
}

describe("user-facing strings", () => {
  test("no placeholder or aria-label is a literal: each goes through t()", () => {
    const offenders: string[] = [];
    for (const dir of ROOTS) {
      for (const path of tsxFiles(join(root, dir))) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(LITERAL)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${relative(root, path)}:${line} ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
