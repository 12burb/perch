import { describe, expect, test } from "bun:test";
import { chunkFile, declarationOn, indexable, looksBinary } from "../src/chunk.ts";

/**
 * Task 2.17 (spec §5.7): the chunker. What matters is that a chunk can be cited — the right file,
 * the right lines, and the name of the thing when the language made one findable — and that nothing
 * a repository is full of (a lockfile, a build directory, a PNG) gets indexed at all.
 */

describe("cutting a repository into chunks", () => {
  test("a declaration becomes its own chunk, from its line to the next one", () => {
    const source = [
      'import { join } from "node:path";',
      "",
      "export function alpha(a: string) {",
      "  return a;",
      "}",
      "",
      "export class Beta {",
      "  go() {}",
      "}",
      "",
    ].join("\n");
    const chunks = chunkFile("src/a.ts", source);
    const symbols = chunks.filter((one) => one.kind === "symbol");
    expect(symbols.map((one) => one.symbol)).toEqual(["alpha", "Beta"]);
    expect(symbols[0]).toMatchObject({ startLine: 3, endLine: 6 });
    expect(symbols[0]?.content).toContain("export function alpha");
    // The imports above the first declaration are kept as a window, not thrown away.
    expect(chunks.some((one) => one.kind === "chunk" && one.content.includes("node:path"))).toBe(
      true,
    );
  });

  test("a file with nothing declared is windowed, with an overlap", () => {
    const source = Array.from({ length: 140 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile("data.txt.ts", source, { windowLines: 50, overlapLines: 10 });
    expect(chunks.every((one) => one.kind === "chunk")).toBe(true);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 50 });
    // The next window starts before the last one ended, so a line on the seam is in both.
    expect(chunks[1]?.startLine).toBe(41);
    expect(chunks.at(-1)?.endLine).toBe(140);
  });

  test("markdown splits at its headings, and each section carries its title", () => {
    const source = [
      "# Perch",
      "",
      "An agentic workspace.",
      "",
      "## Running it",
      "",
      "perch dev",
      "",
    ].join("\n");
    const chunks = chunkFile("README.md", source);
    expect(chunks.map((one) => one.symbol)).toEqual(["Perch", "Running it"]);
    expect(chunks[1]).toMatchObject({ kind: "doc", startLine: 5 });
    expect(chunks[1]?.content).toContain("perch dev");
  });

  test("the languages a declaration can be found in", () => {
    expect(declarationOn("a.ts", "export const thing = () => 1;")).toBe("thing");
    expect(declarationOn("a.py", "async def fetch_it(url):")).toBe("fetch_it");
    expect(declarationOn("a.go", "func (s *Server) Handle(w http.ResponseWriter) {")).toBe(
      "Handle",
    );
    expect(declarationOn("a.rs", "pub async fn run() {}")).toBe("run");
    expect(declarationOn("a.rb", "def valid?")).toBe("valid?");
    expect(declarationOn("a.ts", "  const x = 1;")).toBe("x");
    // A language this does not know says nothing rather than guessing.
    expect(declarationOn("a.lisp", "(defun hello () )")).toBeNull();
  });

  test("what is worth indexing at all", () => {
    expect(indexable("src/app.ts")).toBe(true);
    expect(indexable("docs/README.md")).toBe(true);
    expect(indexable("node_modules/x/index.js")).toBe(false);
    expect(indexable("dist/app.js")).toBe(false);
    expect(indexable("bun.lock")).toBe(false);
    expect(indexable("logo.png")).toBe(false);
    expect(indexable(".git/config")).toBe(false);
  });

  test("bytes that are not text are not chunked", () => {
    // A NUL byte, built rather than typed: a literal one in source does not survive a format.
    const png = `${String.fromCharCode(0)}PNG${"x".repeat(50)}`;
    expect(looksBinary(png)).toBe(true);
    expect(chunkFile("logo.png.ts", png)).toEqual([]);
    expect(chunkFile("empty.ts", "   \n  ")).toEqual([]);
  });

  test("a chunk longer than the limit is cut rather than dropped", () => {
    const long = `export function big() {\n${"  // padding\n".repeat(2000)}}`;
    const chunks = chunkFile("big.ts", long, { maxChars: 500 });
    expect(chunks[0]?.symbol).toBe("big");
    expect(chunks[0]?.content.length).toBeLessThanOrEqual(504);
    expect(chunks[0]?.content.endsWith("...")).toBe(true);
  });
});
