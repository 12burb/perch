import { describe, expect, test } from "bun:test";
import {
  agentsDraft,
  codebaseContext,
  mentionsCodebase,
  questionOf,
  withCodebase,
} from "../src/context.ts";

/**
 * Task 2.17 (spec §5.7): what `@codebase` hands a model, and the AGENTS.md a new project is
 * offered. The property that matters for both is honesty about provenance: every block says which
 * file and which lines it came from, and the draft says only what the repository itself shows.
 */

const chunk = (path: string, content: string, startLine = 1) => ({
  path,
  startLine,
  endLine: startLine + content.split("\n").length - 1,
  content,
});

describe("@codebase", () => {
  test("the marker is found anywhere in the turn, and taken out of the question", () => {
    expect(mentionsCodebase("@codebase where is the vault?")).toBe(true);
    expect(mentionsCodebase("so, @codebase — where?")).toBe(true);
    expect(mentionsCodebase("the codebase is large")).toBe(false);
    expect(mentionsCodebase("hello@codebase.com")).toBe(false);
    expect(questionOf("@codebase where is the vault?")).toBe("where is the vault?");
    expect(questionOf("where is it, @codebase")).toBe("where is it,");
  });

  test("every block cites its file and lines", () => {
    const context = codebaseContext([
      { ...chunk("packages/vault/src/index.ts", "export function seal() {}", 12), symbol: "seal" },
      chunk("docs/vault.md", "The vault is opened once at boot."),
    ]);
    expect(context).toContain("packages/vault/src/index.ts:12-12 — seal");
    expect(context).toContain("docs/vault.md:1-1");
    expect(context).toContain("export function seal() {}");
    // The instruction to cite is in the block itself, not only in a system prompt.
    expect(context).toContain("cite them");
  });

  test("the question stays last, and nothing is prepended when the index found nothing", () => {
    const asked = "where is the vault opened?";
    expect(withCodebase(asked, [])).toBe(asked);
    const withContext = withCodebase(asked, [chunk("a.ts", "x")]);
    expect(withContext.endsWith(asked)).toBe(true);
    expect(withContext.indexOf("a.ts")).toBeLessThan(withContext.indexOf(asked));
  });

  test("a context block stops at its limit rather than crowding out the question", () => {
    const big = Array.from({ length: 50 }, (_, i) => chunk(`f${i}.ts`, "x".repeat(400)));
    const context = codebaseContext(big, { maxChars: 2_000 });
    expect(context.length).toBeLessThanOrEqual(2_000);
    expect(context).toContain("f0.ts");
    expect(context).not.toContain("f49.ts");
  });
});

describe("the AGENTS.md draft", () => {
  test("says what the repository shows and leaves the judgement to a person", () => {
    const draft = agentsDraft({
      name: "nest",
      rootFiles: ["package.json", "README.md"],
      directories: ["src", "docs"],
      scripts: { test: "bun test", build: "bun run build" },
      readme: "Nest is a small bird-watching app.",
    });
    expect(draft).toContain("# nest — agent operating manual");
    expect(draft).toContain("Nest is a small bird-watching app.");
    expect(draft).toContain("`src/`");
    expect(draft).toContain("| `test` | `bun test` |");
    expect(draft).toContain("`package.json`");
    // The parts nobody can derive are marked, not invented.
    expect(draft).toContain("## Ground rules");
    expect(draft.match(/TODO/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("a bare repository still gets a usable skeleton", () => {
    const draft = agentsDraft({ name: "empty", rootFiles: [], directories: [] });
    expect(draft).toContain("# empty — agent operating manual");
    expect(draft).toContain("## Definition of done");
    expect(draft).not.toContain("## Commands");
    expect(draft).not.toContain("## Layout");
  });
});
