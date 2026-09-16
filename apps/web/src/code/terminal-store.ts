/**
 * Commands waiting for a terminal (task 2.18).
 *
 * A quick action of the `run` kind means "type this in my terminal and press enter" — which is
 * exactly what a person would do, and what makes the output land where they already look for it.
 * The action and the terminal are in different parts of the tree, and the terminal may not even be
 * mounted when the action is pressed, so the command waits here until a shell is connected.
 */
import { create } from "zustand";

type TerminalQueue = {
  /** Per project, because a person can have two open and only one is the right one. */
  queued: Record<string, string[]>;
  run: (projectId: string, command: string) => void;
  take: (projectId: string) => string[];
};

export const useTerminalQueue = create<TerminalQueue>((set, get) => ({
  queued: {},
  run: (projectId, command) =>
    set((state) => ({
      queued: { ...state.queued, [projectId]: [...(state.queued[projectId] ?? []), command] },
    })),
  take: (projectId) => {
    const waiting = get().queued[projectId] ?? [];
    if (waiting.length === 0) return [];
    set((state) => {
      const next = { ...state.queued };
      delete next[projectId];
      return { queued: next };
    });
    return waiting;
  },
}));
