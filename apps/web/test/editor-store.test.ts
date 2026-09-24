import { beforeEach, describe, expect, test } from "bun:test";
import { editorFor, useEditorStore } from "../src/code/editor-store.ts";

/** The editor's buffers (task 1.6), and what a save that answers late does to them. */

const P = "project";
const file = () => editorFor(useEditorStore.getState(), P).files.find((f) => f.path === "a.ts");

beforeEach(() => {
  useEditorStore.setState({ byProject: {} });
  const store = useEditorStore.getState();
  store.open(P, "a.ts");
  store.loaded(P, "a.ts", { content: "base", encoding: "utf8", size: 4, truncated: false });
});

describe("the editor store", () => {
  test("typing while a save is on its way survives the save's answer (A-wc-05)", () => {
    const store = useEditorStore.getState();
    store.edit(P, "a.ts", "A");
    // ⌘S sends "A"; the person keeps typing before the write answers.
    const sent = file()?.content ?? "";
    store.edit(P, "a.ts", "AB");
    store.markSaved(P, "a.ts", sent);
    expect(file()?.content).toBe("AB");
    expect(file()?.original).toBe("A");
    // Still dirty: what was typed after ⌘S is not on disk yet.
    expect(file()?.content !== file()?.original).toBe(true);
  });

  test("a save with nothing typed after it leaves the tab clean", () => {
    const store = useEditorStore.getState();
    store.edit(P, "a.ts", "A");
    store.markSaved(P, "a.ts", "A");
    expect(file()?.content).toBe("A");
    expect(file()?.original).toBe("A");
  });

  test("saved (Apply) replaces the buffer with what was written", () => {
    const store = useEditorStore.getState();
    store.edit(P, "a.ts", "A");
    store.saved(P, "a.ts", "applied");
    expect(file()?.content).toBe("applied");
    expect(file()?.original).toBe("applied");
  });
});
