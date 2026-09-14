import { describe, expect, test } from "bun:test";
import { parseHunks, selectHunks, splitPatches } from "../src/unified-diff.ts";

/**
 * Task 1.13: `git diff` output as data. A multi-file diff splits per file with status and counts;
 * a file's patch splits into hunks; a subset of hunks is a patch `git apply` takes.
 */

const NOTES = `diff --git a/notes.txt b/notes.txt
index 1111111..2222222 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1,5 +1,5 @@
 line 1
-line 2
+line 2 (edited)
 line 3
 line 4
 line 5
@@ -13,5 +13,5 @@
 line 13
 line 14
-line 15
+line 15 (edited)
 line 16
 line 17
`;

const ADDED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

const DELETED = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

const RENAMED = `diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
index 5555555..6666666 100644
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-a
+b
`;

const BINARY = `diff --git a/pic.png b/pic.png
index 7777777..8888888 100644
Binary files a/pic.png and b/pic.png differ
`;

describe("unified diffs (task 1.13)", () => {
  test("a multi-file diff splits per file with status, paths, and counts", () => {
    const files = splitPatches(NOTES + ADDED + DELETED + RENAMED + BINARY);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["notes.txt", "modified", 2, 2],
      ["new.txt", "added", 2, 0],
      ["gone.txt", "deleted", 0, 1],
      ["new name.txt", "renamed", 1, 1],
      ["pic.png", "modified", 0, 0],
    ]);
    expect(files[3]?.oldPath).toBe("old name.txt");
    expect(files[0]?.patch).toBe(NOTES);
    expect(files[4]?.patch).toBe(BINARY);
    expect(splitPatches("")).toEqual([]);
  });

  test("a file's patch splits into hunks with their ranges", () => {
    const parsed = parseHunks(NOTES);
    expect(parsed.preamble).toEqual([
      "diff --git a/notes.txt b/notes.txt",
      "index 1111111..2222222 100644",
      "--- a/notes.txt",
      "+++ b/notes.txt",
    ]);
    expect(parsed.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 5, 1, 5],
      [13, 5, 13, 5],
    ]);
    expect(parsed.hunks[1]?.lines).toEqual([
      " line 13",
      " line 14",
      "-line 15",
      "+line 15 (edited)",
      " line 16",
      " line 17",
    ]);
    // A one-line hunk omits the counts.
    expect(parseHunks(DELETED).hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newLines: 0 });
  });

  test("a subset of hunks is a patch of its own", () => {
    const second = selectHunks(NOTES, [1]);
    expect(second).toBe(`diff --git a/notes.txt b/notes.txt
index 1111111..2222222 100644
--- a/notes.txt
+++ b/notes.txt
@@ -13,5 +13,5 @@
 line 13
 line 14
-line 15
+line 15 (edited)
 line 16
 line 17
`);
    expect(selectHunks(NOTES, [1, 0, 1])).toBe(NOTES);
    expect(selectHunks(NOTES, [7])).toBe("");
  });
});
