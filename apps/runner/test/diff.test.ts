import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "../src/diff.ts";

describe("unifiedDiff (task 1.9)", () => {
  test("a new file, a change in the middle, and no change", () => {
    const added = unifiedDiff("notes.txt", null, "hello\nworld\n");
    expect(added.additions).toBe(2);
    expect(added.deletions).toBe(0);
    expect(added.patch).toBe("--- /dev/null\n+++ b/notes.txt\n@@ -1,0 +1,2 @@\n+hello\n+world\n");

    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j"].join("\n");
    const changed = unifiedDiff("x.txt", before, after);
    expect(changed.additions).toBe(1);
    expect(changed.deletions).toBe(1);
    expect(changed.patch).toBe(
      "--- a/x.txt\n+++ b/x.txt\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n",
    );

    const same = unifiedDiff("y.txt", "one\n", "one\n");
    expect(same).toEqual({ patch: "", additions: 0, deletions: 0 });
  });

  test("two far-apart changes become two hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const after = [...lines];
    after[2] = "changed 2";
    after[27] = "changed 27";
    const diff = unifiedDiff("z.txt", lines.join("\n"), after.join("\n"));
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(2);
    const hunks = diff.patch.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunks).toEqual(["@@ -1,6 +1,6 @@", "@@ -25,6 +25,6 @@"]);
  });
});
