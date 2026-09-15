import { describe, expect, test } from "bun:test";
import { parseFenceInfo, proposedCode, splitCodeBlocks } from "../src/code-blocks.ts";

/**
 * Tasks 1.13 and 1.14: a reply's fenced blocks, the file a fence names, and the code a reply
 * proposes when the editor asked for one.
 */
describe("code blocks in a reply", () => {
  test("a fence's info string names the language and the file", () => {
    expect(parseFenceInfo("ts path=src/a.ts")).toEqual({ lang: "ts", path: "src/a.ts" });
    expect(parseFenceInfo("ts:src/a.ts")).toEqual({ lang: "ts", path: "src/a.ts" });
    expect(parseFenceInfo('ts title="src/a b.ts"')).toEqual({ lang: "ts", path: "src/a b.ts" });
    expect(parseFenceInfo("ts src/a.ts")).toEqual({ lang: "ts", path: "src/a.ts" });
    // A bare file name is a file, not a language; its extension stands in for one.
    expect(parseFenceInfo("src/a.ts")).toEqual({ lang: "ts", path: "src/a.ts" });
    expect(parseFenceInfo("Makefile")).toEqual({ lang: "Makefile", path: null });
    expect(parseFenceInfo("")).toEqual({ lang: null, path: null });
  });

  test("text and code split in order, and a longer fence nests a shorter one", () => {
    const parts = splitCodeBlocks("before\n```txt path=a.txt\nhello\n```\nafter");
    expect(parts.map((part) => part.kind)).toEqual(["text", "code", "text"]);
    expect(parts[1]).toMatchObject({ kind: "code", path: "a.txt", code: "hello", open: false });

    const nested = splitCodeBlocks("````md\n```ts\nconst a = 1;\n```\n````");
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({
      kind: "code",
      lang: "md",
      code: "```ts\nconst a = 1;\n```",
      open: false,
    });
  });

  test("a fence still open mid-stream is a block of its own", () => {
    const parts = splitCodeBlocks("writing\n```ts\nconst a =");
    expect(parts.map((part) => part.kind)).toEqual(["text", "code"]);
    expect(parts[1]).toMatchObject({ kind: "code", open: true, code: "const a =" });
    expect(splitCodeBlocks("just text")).toEqual([{ kind: "text", text: "just text" }]);
  });

  test("the proposal is the fenced block, or the bare text when there is none", () => {
    expect(proposedCode("Sure:\n```ts\nconst a = 1;\n```\nHope that helps.")).toBe("const a = 1;");
    // A model that answers with the code and nothing else.
    expect(proposedCode("const a = 1;\n")).toBe("const a = 1;");
    // A block still streaming is better than nothing.
    expect(proposedCode("here:\n```ts\nconst a =")).toBe("const a =");
    // The first complete block wins over a later one.
    expect(proposedCode("```ts\none\n```\nand\n```ts\ntwo\n```")).toBe("one");
    expect(proposedCode("")).toBe("");
  });
});
