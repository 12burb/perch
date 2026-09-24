import { create } from "zustand";

/**
 * Open files per project (task 1.6): the editor's tabs live outside React Query because a file's
 * buffer diverges from what the server has until Save. The tree and the api are the source of
 * truth for everything else.
 */

export type OpenFile = {
  path: string;
  /** The buffer as edited. */
  content: string;
  /** What the server last gave or accepted; dirty = content !== original. */
  original: string;
  encoding: "utf8" | "base64";
  size: number;
  truncated: boolean;
  loaded: boolean;
  error: string | null;
  /** Markdown: render instead of edit. */
  preview: boolean;
  /** A line to reveal once the editor mounts (search results). */
  revealLine: number | null;
};

type ProjectEditor = { files: OpenFile[]; active: string | null };

type EditorState = {
  byProject: Record<string, ProjectEditor>;
  open: (project: string, path: string, options?: { line?: number }) => void;
  close: (project: string, path: string) => void;
  select: (project: string, path: string) => void;
  loaded: (
    project: string,
    path: string,
    file: Pick<OpenFile, "content" | "encoding" | "size" | "truncated">,
  ) => void;
  failed: (project: string, path: string, error: string) => void;
  edit: (project: string, path: string, content: string) => void;
  /** Something other than the buffer wrote the file (Apply): the buffer becomes what was written. */
  saved: (project: string, path: string, content: string) => void;
  /**
   * The buffer's own save answered: what was sent is now on disk. The buffer is left alone, since
   * the person may have typed on while the write was on its way; that typing stays, and dirty.
   */
  markSaved: (project: string, path: string, savedContent: string) => void;
  setPreview: (project: string, path: string, preview: boolean) => void;
  revealed: (project: string, path: string) => void;
  /** Marks open files as stale after the disk changed underneath them (a restore, a rejected hunk); the pane fetches them again. */
  reload: (project: string, paths?: readonly string[]) => void;
};

const EMPTY: ProjectEditor = { files: [], active: null };

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function update(
  state: EditorState,
  project: string,
  path: string,
  patch: (file: OpenFile) => OpenFile,
): Partial<EditorState> {
  const editor = state.byProject[project] ?? EMPTY;
  return {
    byProject: {
      ...state.byProject,
      [project]: {
        ...editor,
        files: editor.files.map((file) => (file.path === path ? patch(file) : file)),
      },
    },
  };
}

export const useEditorStore = create<EditorState>((set) => ({
  byProject: {},
  open: (project, path, options) =>
    set((state) => {
      const editor = state.byProject[project] ?? EMPTY;
      const existing = editor.files.find((file) => file.path === path);
      const files = existing
        ? editor.files.map((file) =>
            file.path === path ? { ...file, revealLine: options?.line ?? file.revealLine } : file,
          )
        : [
            ...editor.files,
            {
              path,
              content: "",
              original: "",
              encoding: "utf8" as const,
              size: 0,
              truncated: false,
              loaded: false,
              error: null,
              preview: isMarkdown(path),
              revealLine: options?.line ?? null,
            },
          ];
      return { byProject: { ...state.byProject, [project]: { files, active: path } } };
    }),
  close: (project, path) =>
    set((state) => {
      const editor = state.byProject[project] ?? EMPTY;
      const index = editor.files.findIndex((file) => file.path === path);
      const files = editor.files.filter((file) => file.path !== path);
      const active =
        editor.active === path
          ? (files[Math.min(Math.max(index, 0), files.length - 1)]?.path ?? null)
          : editor.active;
      return { byProject: { ...state.byProject, [project]: { files, active } } };
    }),
  select: (project, path) =>
    set((state) => ({
      byProject: {
        ...state.byProject,
        [project]: { ...(state.byProject[project] ?? EMPTY), active: path },
      },
    })),
  loaded: (project, path, file) =>
    set((state) =>
      update(state, project, path, (open) => ({
        ...open,
        ...file,
        original: file.content,
        loaded: true,
        error: null,
      })),
    ),
  failed: (project, path, error) =>
    set((state) => update(state, project, path, (open) => ({ ...open, loaded: true, error }))),
  edit: (project, path, content) =>
    set((state) => update(state, project, path, (open) => ({ ...open, content }))),
  saved: (project, path, content) =>
    set((state) =>
      update(state, project, path, (open) => ({ ...open, original: content, content })),
    ),
  markSaved: (project, path, savedContent) =>
    set((state) => update(state, project, path, (open) => ({ ...open, original: savedContent }))),
  setPreview: (project, path, preview) =>
    set((state) => update(state, project, path, (open) => ({ ...open, preview }))),
  revealed: (project, path) =>
    set((state) => update(state, project, path, (open) => ({ ...open, revealLine: null }))),
  reload: (project, paths) =>
    set((state) => {
      const editor = state.byProject[project] ?? EMPTY;
      const wanted = paths ? new Set(paths) : null;
      return {
        byProject: {
          ...state.byProject,
          [project]: {
            ...editor,
            files: editor.files.map((file) =>
              wanted && !wanted.has(file.path) ? file : { ...file, loaded: false },
            ),
          },
        },
      };
    }),
}));

export function editorFor(state: EditorState, project: string): ProjectEditor {
  return state.byProject[project] ?? EMPTY;
}
