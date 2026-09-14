/**
 * The runners the api can reach right now (spec §3.2): hosted runners registered by the supervisor,
 * local runners connected over /api/runner (task 1.3), and the in-process runner in laptop mode.
 * Every runner is a RunnerLink; the registry tracks heartbeats and publishes runner.* bus events.
 */
import type { Bus } from "@perch/bus";
import type { RunnerLink } from "@perch/events";

export type ListeningPort = { port: number; pid?: number };

export type RegisteredRunner = {
  link: RunnerLink;
  attachedAt: Date;
  lastHeartbeatAt: Date | null;
  load: { cpu?: number; memoryMb?: number };
  sessions: string[];
  /** The ports the runner last reported listening (ports.changed, task 1.5). */
  ports: ListeningPort[];
  /** The workspace a hosted runner belongs to; null for the laptop runner (every workspace). */
  workspaceId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RunnerRegistry {
  private readonly runners = new Map<string, RegisteredRunner & { unsubscribe: () => void }>();

  constructor(private readonly bus: Bus) {}

  attach(link: RunnerLink, options: { workspaceId?: string | null } = {}): RegisteredRunner {
    const entry: RegisteredRunner & { unsubscribe: () => void } = {
      link,
      attachedAt: new Date(),
      lastHeartbeatAt: null,
      load: {},
      sessions: [],
      ports: [],
      workspaceId: options.workspaceId ?? null,
      unsubscribe: () => {},
    };
    entry.unsubscribe = link.onNotification((notification) => {
      if (notification.method === "runner.heartbeat") {
        entry.lastHeartbeatAt = new Date();
        entry.load = notification.params.load;
        entry.sessions = notification.params.sessions;
      } else if (notification.method === "ports.changed") {
        const known = new Set(entry.ports.map((p) => p.port));
        entry.ports = notification.params.ports;
        // A new port on a workspace's runner is a preview candidate (spec §5.6); the shared and
        // in-process runners have no workspace to tell.
        if (entry.workspaceId && UUID.test(link.id)) {
          for (const { port } of notification.params.ports) {
            if (known.has(port)) continue;
            void this.bus
              .publish(
                "preview.port_detected",
                { workspaceId: entry.workspaceId, runnerId: link.id, port },
                { actor: { type: "runner", id: link.id } },
              )
              .catch(() => {});
          }
        }
      }
    });
    this.runners.set(link.id, entry);
    return entry;
  }

  async detach(id: string): Promise<void> {
    const entry = this.runners.get(id);
    if (!entry) return;
    entry.unsubscribe();
    this.runners.delete(id);
    await entry.link.close();
  }

  get(id: string): RegisteredRunner | undefined {
    return this.runners.get(id);
  }

  list(): RegisteredRunner[] {
    return [...this.runners.values()];
  }

  get size(): number {
    return this.runners.size;
  }

  /** Runners usable for a workspace: its own hosted runners plus every workspace-less (laptop) one. */
  forWorkspace(workspaceId: string): RegisteredRunner[] {
    return this.list().filter((r) => r.workspaceId === null || r.workspaceId === workspaceId);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.runners.keys()]) await this.detach(id);
  }

  /** Kept for symmetry with the WS server: runner.* bus events arrive with the supervisor (1.2). */
  get events(): Bus {
    return this.bus;
  }
}
