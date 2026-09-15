/**
 * Who owns ⌘K (spec §4: the command palette everywhere, except a focused editor with a selection,
 * where it is the inline edit of task 1.14). The editor sees the keydown first — it is deep in the
 * tree and the shell listens on the window — so it claims the event, and the shell stands down for
 * that one event. This module stays free of editor imports so the shell does not pull CodeMirror in.
 */
let claimed: KeyboardEvent | null = null;

/** Called by an editor that handled ⌘K itself. */
export function claimCommandKey(event: KeyboardEvent): void {
  claimed = event;
}

/** True for the very event an editor claimed, and nothing else. */
export function editorOwnsCommandKey(event: KeyboardEvent): boolean {
  return claimed !== null && claimed === event;
}
