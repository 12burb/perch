/**
 * A quick action waiting for the session pane (task 2.18).
 *
 * ⌘K can fire an action while the pane is not mounted — no session open, or the panel folded away.
 * The command names the action and leaves it here; the route opens a session, the pane mounts and
 * takes it. One per project, because pressing the same command twice should not queue two turns.
 */
import { create } from "zustand";

type ActionQueue = {
  queued: Record<string, string>;
  run: (projectId: string, actionId: string) => void;
  take: (projectId: string) => string | null;
};

export const useActionQueue = create<ActionQueue>((set, get) => ({
  queued: {},
  run: (projectId, actionId) =>
    set((state) => ({ queued: { ...state.queued, [projectId]: actionId } })),
  take: (projectId) => {
    const waiting = get().queued[projectId];
    if (!waiting) return null;
    set((state) => {
      const next = { ...state.queued };
      delete next[projectId];
      return { queued: next };
    });
    return waiting;
  },
}));
