/**
 * The runners the api can reach right now (spec §3.2): hosted runners registered by the supervisor,
 * local runners connected over /api/runner (task 1.3), and the in-process runner in laptop mode.
 * Every runner is a RunnerLink; the registry tracks heartbeats and publishes runner.* bus events.
 */
import type { Bus } from "@perch/bus";
import type { RunnerLink } from "@perch/events";
import { ids, span } from "../telemetry/tracing.ts";

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

/**
 * Every runner RPC is a span (spec §5.7 "OTel traces and cost per task"; task 3.22). It is wrapped
 * here rather than in `runnerCall` because "every RPC" has to mean every one: a project's setup and
 * a terminal take the link out of the registry and call it directly, and a helper only traces the
 * callers who remember to use it.
 *
 * The attributes are the call's ids and its method, never its parameters: an `fs.write` carries the
 * file it is writing, and a trace is not a place to keep one (§9.1's log rule).
 */
function traced(link: RunnerLink): RunnerLink {
  const wrapped: RunnerLink = {
    get id() {
      return link.id;
    },
    get info() {
      return link.info;
    },
    call: (method, params, options) => {
      const where = params as {
        workspace_id?: string;
        user_id?: string;
        project?: string;
        session_id?: string;
      };
      return span(
        `runner.${method}`,
        {
          "perch.runner_id": link.id,
          "rpc.method": method,
          ...ids({
            workspaceId: where.workspace_id,
            userId: where.user_id,
            projectId: where.project,
            sessionId: where.session_id,
          }),
        },
        () => link.call(method, params, options),
      );
    },
    onNotification: (handler) => link.onNotification(handler),
    close: () => link.close(),
  };
  // Optional by interface and checked for by presence (a tunnelled preview needs one), so the
  // wrapper has it exactly when the link does.
  if (link.openStream) wrapped.openStream = (token) => link.openStream?.(token) ?? never();
  return wrapped;
}

function never(): never {
  throw new Error("this runner stopped offering streams mid-call");
}

type Entry = RegisteredRunner & { raw: RunnerLink; unsubscribe: () => void };

export class RunnerRegistry {
  private readonly runners = new Map<string, Entry>();

  constructor(private readonly bus: Bus) {}

  attach(raw: RunnerLink, options: { workspaceId?: string | null } = {}): RegisteredRunner {
    // A runner that registers again while its previous socket lingers replaces it: the old link
    // is closed here (its own teardown then finds a newer entry and leaves it be, ADR-0163).
    const previous = this.runners.get(raw.id);
    if (previous) {
      previous.unsubscribe();
      this.runners.delete(raw.id);
      void previous.link.close().catch(() => {});
    }
    const link = traced(raw);
    const entry: Entry = {
      raw,
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

  /** Removes a runner; with `only`, just when that is the link still registered under the id. */
  async detach(id: string, only?: RunnerLink): Promise<void> {
    const entry = this.runners.get(id);
    if (!entry) return;
    if (only && entry.raw !== only) return;
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
