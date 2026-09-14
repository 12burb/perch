import { describe, expect, test } from "bun:test";
import { parseFenceInfo, splitCodeBlocks } from "../src/components/code-blocks.ts";

/**
 * Task 1.13 "Apply on code blocks": a reply's fenced blocks, and the file a fence names.
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
    expect(parts.map((p) => p.kind)).toEqual(["text", "code", "text"]);
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
    expect(parts.map((p) => p.kind)).toEqual(["text", "code"]);
    expect(parts[1]).toMatchObject({ kind: "code", open: true, code: "const a =" });
    expect(splitCodeBlocks("just text")).toEqual([{ kind: "text", text: "just text" }]);
  });
});
