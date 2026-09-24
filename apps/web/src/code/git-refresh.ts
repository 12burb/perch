/**
 * What the Git panel refreshes after an action (task 1.20). Every action refreshes the panel's own
 * queries and every file query of the project (the tree, its search, the reads the editor made,
 * all under `fsKey`). A checkout also changes what the files hold, so the open buffers are loaded
 * again from the branch that is now checked out: an editor still holding the old branch's text
 * would write it onto the new branch with the next save.
 */
import type { QueryClient } from "@tanstack/react-query";
import { fsKey } from "../lib/queries.ts";
import { useEditorStore } from "./editor-store.ts";

export async function refreshAfterGit(
  queryClient: QueryClient,
  workspaceId: string,
  projectId: string,
  options: { checkout?: boolean } = {},
): Promise<void> {
  const refreshed = Promise.all([
    queryClient.invalidateQueries({ queryKey: ["git", workspaceId, projectId] }),
    queryClient.invalidateQueries({ queryKey: fsKey(workspaceId, projectId) }),
  ]);
  // After the invalidation marked the reads stale, so the editor's reload fetches them anew.
  if (options.checkout) useEditorStore.getState().reload(projectId);
  await refreshed;
}
