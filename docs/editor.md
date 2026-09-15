# The editor (Code mode)

Task 1.6 (spec §5.1, §4): open a project from Code mode and its files are yours to browse, edit,
and save from the browser or the desktop app, on any runner the project lives on.

## What is there

- **File tree** (sidebar, Code mode, with a project open): directories load when expanded, the
  visible rows are virtualized, and the whole tree is an ARIA tree you can drive with the keyboard
  (arrows, Home/End, Enter). "All projects" goes back to the list. A search box above the tree runs
  `fs.search` on the runner (literal, smart case, ripgrep when the runner has it) and lists matches
  that open the file at that line.
- **Editor group** (main): tabs with a dirty marker, breadcrumbs of the open file's path, and the
  editor. Tabs move with ←/→, Home/End; Delete or ⌘W closes the focused tab; the breadcrumb bar's
  Close button closes the active one (the pointer-only × on each tab is not in the accessibility
  tree, since a tablist may own nothing but tabs).
- **CodeMirror 6** with the language picked from the filename (~40 languages, loaded on demand),
  line numbers, folding, bracket matching, multiple selections and rectangular selection,
  search/replace (⌘F / ⌘⌥F), history. ⌘S or the Save button writes the file back through the api
  (`PUT …/fs/write`); a file over 2 MiB opens read-only with a notice.
- **Markdown** opens in preview (rendered from the @lezer/markdown tree straight into React: no HTML
  pass-through, so a README cannot script the app; CommonMark plus GFM tables, strikethrough, task
  lists) with a Source / Preview toggle.
- **Images** (png, jpg, gif, webp, bmp, ico, avif, svg) preview; other binary files say so.
- Closing a tab with unsaved changes asks first. Tabs live in memory for the session; the files
  live on the runner.

## The api behind it

`/api/workspaces/{ws}/projects/{project}/fs/*` forwards to the project's runner as the §7.6 fs
methods with the member as `user_id` (ADR-0071):

| Route | Runner method | Policy action |
|---|---|---|
| `GET …/fs/list?path=` | `fs.list` | `projects.read` |
| `GET …/fs/read?path=` | `fs.read` | `projects.read` |
| `GET …/fs/stat?path=` | `fs.stat` | `projects.read` |
| `PUT …/fs/write` `{path, content, encoding?}` | `fs.write` (emits `project.updated` with `files`) | `projects.update` |
| `GET …/fs/search?q=&glob=&limit=&regex=&ignore_case=` | `fs.search` | `projects.read` |

Paths are validated at the api (relative, no `..`, no drive letters → 422) and again on the
runner; a runner policy refusal (writing under `.git/`) is a 451 `policy_violation`; a project still
setting up is a 409; a runner that is offline is a 409 too.

## From code

```ts
import { EditorGroup } from "@perch/ui"; // tabs + breadcrumbs + the tabpanel; the editor is the child
```

`apps/web/src/code/` holds the rest: `code-editor.tsx` (CodeMirror), `markdown.tsx` (the
renderer), `file-tree.tsx`, `editor-store.ts` (open files per project, zustand), `editor-pane.tsx`.

## ⌘K inline edit (task 1.14)

Select something in the editor and press ⌘K (Ctrl+K): a bar above the editor asks what to change.
The agent answers with the replacement, which lands in the buffer with the replaced lines struck
through above it and the new lines highlighted — the diff in place of spec §4.

- **Accept** keeps the proposal in the buffer. Nothing is written until ⌘S, like any other edit.
- **Reject** (or Esc, or switching tabs) puts the original text back.
- The agent is asked for the replacement and nothing else, and is told not to edit files; a
  permission it asks for mid-round is refused, since nobody is watching (ADR-0080).
- ⌘K with no selection is still the command palette. The editor claims the keydown only when it
  has a selection, and the palette stands down for that one event.

`POST /api/workspaces/{ws}/projects/{p}/inline-edit` `{path, selection, instruction, language?}`
answers `{replacement, session_id}`. The round runs on a hidden session of kind `inline`, one per
person and project, reused across edits and kept out of the Sessions list; its events stay on
`session:<id>` because its turns carry the selection.

The session pane (task 1.12) opens in the panel beside the editor from the sidebar's Sessions
section; see [`sessions.md`](sessions.md).
