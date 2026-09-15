import { create } from "zustand";

/**
 * Context chips (spec §5.6 "Select → describe: selected element becomes a context chip; the agent
 * edits the right file"; task 2.16).
 *
 * A chip is made somewhere that knows something — the Preview tab's inspector, its console strip —
 * and used somewhere else: the session composer, which sends it with the next turn. Keeping them
 * here rather than passing them down is what lets the two panes stay unaware of each other.
 */

export type ContextChip = {
  id: string;
  /** What the person sees on the chip. */
  label: string;
  /** What the agent is told, which is the part that has to be unambiguous. */
  text: string;
  kind: "element" | "console" | "request" | "screenshot";
};

type ContextState = {
  byProject: Record<string, ContextChip[]>;
  add: (project: string, chip: Omit<ContextChip, "id"> & { id?: string }) => void;
  remove: (project: string, id: string) => void;
  clear: (project: string) => void;
};

const MAX = 8;

export const useContextChips = create<ContextState>((set) => ({
  byProject: {},
  add: (project, chip) =>
    set((state) => {
      const id = chip.id ?? `${chip.kind}:${chip.text}`;
      const kept = (state.byProject[project] ?? []).filter((one) => one.id !== id);
      // Newest last, and never an unbounded pile: a prompt is not a log.
      const next = [...kept, { ...chip, id }].slice(-MAX);
      return { byProject: { ...state.byProject, [project]: next } };
    }),
  remove: (project, id) =>
    set((state) => ({
      byProject: {
        ...state.byProject,
        [project]: (state.byProject[project] ?? []).filter((one) => one.id !== id),
      },
    })),
  clear: (project) => set((state) => ({ byProject: { ...state.byProject, [project]: [] } })),
}));

/** What the chips add to a turn: one block above whatever the person wrote. */
export function withChips(text: string, chips: readonly ContextChip[]): string {
  if (chips.length === 0) return text;
  const lines = chips.map((chip) => `- ${chip.text}`).join("\n");
  return `Context from the preview:\n${lines}\n\n${text}`;
}
