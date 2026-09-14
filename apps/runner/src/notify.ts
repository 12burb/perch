import type { RunnerNotification } from "@perch/events";

/** Runner → api notifications from handlers and watchers, fanned out to whoever is connected. */
export type Notify = (notification: RunnerNotification) => void;

export function createNotifier(): {
  emit: Notify;
  subscribe: (handler: Notify) => () => void;
} {
  const handlers = new Set<Notify>();
  return {
    emit: (notification) => {
      for (const handler of handlers) handler(notification);
    },
    subscribe: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
