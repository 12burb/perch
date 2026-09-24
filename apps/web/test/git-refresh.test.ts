import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { editorFor, useEditorStore } from "../src/code/editor-store.ts";
import { refreshAfterGit } from "../src/code/git-refresh.ts";
import { fsListQuery, fsReadQuery, fsSearchQuery, gitStatusQuery } from "../src/lib/queries.ts";

/** What the Git panel refreshes after it changed the working tree (A-wc-06). */

const WS = "ws";
const P = "project";

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(fsListQuery(WS, P, "").queryKey, []);
  client.setQueryData(fsListQuery(WS, P, "src").queryKey, []);
  client.setQueryData(fsSearchQuery(WS, P, "todo").queryKey, {
    matches: [],
    truncated: false,
  } as never);
  client.setQueryData(fsReadQuery(WS, P, "README.md").queryKey, {
    content: "main",
  } as never);
  client.setQueryData(gitStatusQuery(WS, P).queryKey, { branch: "main", files: [] } as never);
  // Another project's tree is none of this refresh's business.
  client.setQueryData(fsListQuery(WS, "other", "").queryKey, []);
  return client;
}

const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated === true;

beforeEach(() => {
  useEditorStore.setState({ byProject: {} });
  const store = useEditorStore.getState();
  store.open(P, "README.md");
  store.loaded(P, "README.md", { content: "main", encoding: "utf8", size: 4, truncated: false });
});

describe("refreshAfterGit", () => {
  test("marks every file query of the project stale: the tree, its search and its reads", async () => {
    const client = seeded();
    await refreshAfterGit(client, WS, P);
    expect(invalidated(client, fsListQuery(WS, P, "").queryKey)).toBe(true);
    expect(invalidated(client, fsListQuery(WS, P, "src").queryKey)).toBe(true);
    expect(invalidated(client, fsSearchQuery(WS, P, "todo").queryKey)).toBe(true);
    expect(invalidated(client, fsReadQuery(WS, P, "README.md").queryKey)).toBe(true);
    expect(invalidated(client, gitStatusQuery(WS, P).queryKey)).toBe(true);
    expect(invalidated(client, fsListQuery(WS, "other", "").queryKey)).toBe(false);
  });

  test("a checkout reloads the open buffers from the branch; a commit leaves them alone", async () => {
    const client = seeded();
    await refreshAfterGit(client, WS, P);
    expect(editorFor(useEditorStore.getState(), P).files[0]?.loaded).toBe(true);
    await refreshAfterGit(client, WS, P, { checkout: true });
    expect(editorFor(useEditorStore.getState(), P).files[0]?.loaded).toBe(false);
  });
});
