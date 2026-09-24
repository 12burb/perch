/**
 * Where a change of person in this tab ends: a full load of `path` (A-wc-10).
 *
 * Everything the app holds in memory belongs to whoever was signed in: the query cache (their
 * identity, their workspaces, channels and inbox, which `ensureQueryData` would hand the next
 * person as if it were theirs), the editor's buffers, context chips, queued actions and terminal
 * commands, the socket. A reload is the one reset that cannot miss a store somebody adds later, so
 * signing in, signing up and signing out all end in one. `path` is a same-origin path: `/sign-in`,
 * or a redirect `safeRedirect` has already checked.
 */
export function startFresh(path: string, how: "push" | "replace" = "push"): void {
  if (how === "replace") window.location.replace(path);
  else window.location.assign(path);
}
