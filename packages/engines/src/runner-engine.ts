/**
 * An engine hosted on a runner (spec §7.6 session.* methods; task 1.8): the api-side half of every
 * adapter that runs in the runner image or on a local runner (acp, opencode, cli-harness from task
 * 1.9 on). Calls map one to one onto the runner protocol; the runner's session.event notifications
 * for a session become the AsyncIterable a round answers with.
 */
import {
  type EngineEvent,
  type PermissionAnswer,
  type RunnerLink,
  sessionCreateResultSchema,
  type UserTurn,
} from "@perch/events";
import {
  type CreateSessionParams,
  type Engine,
  type EngineCapabilities,
  EngineError,
  type EngineSession,
  type SendOptions,
} from "./engine.ts";

export type RunnerEngineOptions = {
  id: string;
  link: RunnerLink;
  capabilities?: Partial<EngineCapabilities>;
};

type Live = {
  params: CreateSessionParams;
  projectId: string;
  queue: EngineEvent[];
  wake: (() => void) | null;
  running: boolean;
};

export type RunnerEngine = Engine & { dispose(): void };

export function runnerEngine(options: RunnerEngineOptions): RunnerEngine {
  const { id, link } = options;
  const sessions = new Map<string, Live>();
  const unsubscribe = link.onNotification((notification) => {
    if (notification.method !== "session.event") return;
    const live = sessions.get(notification.params.session_id);
    if (!live) return;
    live.queue.push(notification.params.event);
    live.wake?.();
  });
  const live = (sessionId: string): Live => {
    const session = sessions.get(sessionId);
    if (!session) throw new EngineError(`unknown session ${sessionId}`, "unknown_session");
    return session;
  };
  const ctx = (session: Live) => ({
    workspace_id: session.params.workspaceId,
    user_id: session.params.userId,
  });

  return {
    id,
    capabilities: {
      code: true,
      tools: true,
      subagents: false,
      streaming: true,
      ...options.capabilities,
    },
    async createSession(params: CreateSessionParams): Promise<EngineSession> {
      if (!params.projectId) {
        throw new EngineError(`engine ${id} runs in a project on a runner`, "unavailable");
      }
      const session: Live = {
        params,
        projectId: params.projectId,
        queue: [],
        wake: null,
        running: false,
      };
      sessions.set(params.sessionId, session);
      let raw: unknown;
      try {
        raw = await link.call("session.create", {
          ...ctx(session),
          session_id: params.sessionId,
          project: params.projectId,
          engine: id,
          ...(params.agent ? { agent: params.agent } : {}),
          model: params.model,
          mode: params.mode,
          ...(params.worktree ? { worktree: params.worktree } : {}),
          ...(params.env ? { env: params.env } : {}),
          ...(params.mcpServers?.length ? { mcp_servers: params.mcpServers } : {}),
        });
      } catch (error) {
        sessions.delete(params.sessionId);
        throw error;
      }
      const result = sessionCreateResultSchema.safeParse(raw);
      const engineSessionId = result.success ? result.data.engine_session_id : undefined;
      return { id: params.sessionId, ...(engineSessionId ? { engineSessionId } : {}) };
    },
    async *send(
      sessionId: string,
      input: UserTurn,
      opts?: SendOptions,
    ): AsyncIterable<EngineEvent> {
      const session = live(sessionId);
      if (session.running) throw new EngineError("a round is already running", "busy");
      session.running = true;
      session.queue.length = 0;
      try {
        await link.call("session.send", {
          ...ctx(session),
          session_id: sessionId,
          turn: input,
          ...(opts?.mode ? { mode: opts.mode } : {}),
          ...(opts?.reasoning ? { reasoning: opts.reasoning } : {}),
        });
        for (;;) {
          let next = session.queue.shift();
          while (next) {
            yield next;
            if (next.type === "done" || next.type === "error") return;
            next = session.queue.shift();
          }
          await new Promise<void>((resolve) => {
            session.wake = resolve;
          });
          session.wake = null;
        }
      } finally {
        session.running = false;
        session.wake = null;
      }
    },
    async respondPermission(
      sessionId: string,
      permissionId: string,
      answer: PermissionAnswer,
    ): Promise<void> {
      const session = live(sessionId);
      await link.call("session.permission", {
        ...ctx(session),
        session_id: sessionId,
        permission_id: permissionId,
        answer,
      });
    },
    async cancel(sessionId: string): Promise<void> {
      const session = live(sessionId);
      await link.call("session.cancel", { ...ctx(session), session_id: sessionId });
    },
    async close(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
    },
    dispose(): void {
      unsubscribe();
      sessions.clear();
    },
  };
}
