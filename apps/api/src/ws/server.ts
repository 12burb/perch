/**
 * The WebSocket server at /api/ws (spec §7.2): subscribe / unsubscribe / ping / typing / presence /
 * resume over the bus's per-topic seqs and replay buffer. One authenticated user per connection; every
 * topic is authorized on subscribe; events are fanned out as { type, topic, seq, ts, payload }.
 */
import type { Bus, Unsubscribe } from "@perch/bus";
import type { Db, User } from "@perch/db";
import {
  type BusEvent,
  WS_CONTROL_TYPES,
  WS_REPLAY_BUFFER,
  type WsClientOp,
  type WsServerEnvelope,
  wsClientOpSchema,
} from "@perch/events";
import type { Context } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { Logger } from "pino";
import type { AppEnv } from "../context.ts";
import { PresenceRegistry } from "./presence.ts";
import { authorizeTopic, parseTopic } from "./topics.ts";

export type WsServerDeps = { bus: Bus; db: Db; log: Logger };

type Connection = {
  id: string;
  user: User;
  ws: WSContext<unknown>;
  /** topic → unsubscribe from the bus topic. */
  subscriptions: Map<string, Unsubscribe>;
  /** Workspaces this connection subscribed to (ws:<id>), for presence. */
  workspaces: Set<string>;
  lastTyping: Map<string, number>;
};

const TYPING_INTERVAL_MS = 1500;

export function createWsServer(deps: WsServerDeps) {
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const presence = new PresenceRegistry();
  const connections = new Map<string, Connection>();

  function send(conn: Connection, envelope: WsServerEnvelope): void {
    if (conn.ws.readyState !== 1) return;
    conn.ws.send(JSON.stringify(envelope));
  }

  function control(conn: Connection, type: string, payload: unknown, topic = "", seq = 0): void {
    send(conn, { type, topic, seq, ts: new Date().toISOString(), payload });
  }

  function fail(conn: Connection, op: string, code: string, message: string, topic = ""): void {
    control(conn, WS_CONTROL_TYPES.error, { code, message, op }, topic);
  }

  function fanout(conn: Connection, topic: string, event: BusEvent, seq: number): void {
    // The envelope carries the payload only; the actor and request meta never leave the server.
    send(conn, { type: event.type, topic, seq, ts: event.ts, payload: event.payload });
  }

  async function subscribe(conn: Connection, topics: string[]): Promise<void> {
    for (const topic of topics) {
      if (conn.subscriptions.has(topic)) {
        control(conn, WS_CONTROL_TYPES.subscribed, { topic }, topic, deps.bus.seq(topic));
        continue;
      }
      const parsed = parseTopic(topic);
      if (!parsed) {
        fail(conn, "subscribe", "validation", "topic must be <kind>:<id>", topic);
        continue;
      }
      const grant = await authorizeTopic(deps.db, conn.user.id, parsed);
      if (!grant.allowed) {
        fail(conn, "subscribe", grant.code, grant.message, topic);
        continue;
      }
      const unsubscribe = deps.bus.subscribeTopic(topic, (event, seq) =>
        fanout(conn, topic, event, seq),
      );
      conn.subscriptions.set(topic, unsubscribe);
      control(conn, WS_CONTROL_TYPES.subscribed, { topic }, topic, deps.bus.seq(topic));
      if (parsed.kind === "ws") {
        conn.workspaces.add(parsed.id);
        control(
          conn,
          WS_CONTROL_TYPES.presence_snapshot,
          { workspaceId: parsed.id, users: presence.snapshot(parsed.id) },
          topic,
          deps.bus.seq(topic),
        );
      }
    }
  }

  async function unsubscribe(conn: Connection, topics: string[]): Promise<void> {
    for (const topic of topics) {
      const off = conn.subscriptions.get(topic);
      if (!off) continue;
      off();
      conn.subscriptions.delete(topic);
      const parsed = parseTopic(topic);
      if (parsed?.kind === "ws") {
        conn.workspaces.delete(parsed.id);
        await leaveWorkspace(conn, parsed.id);
      }
      control(conn, WS_CONTROL_TYPES.unsubscribed, { topic }, topic, deps.bus.seq(topic));
    }
  }

  async function setPresence(conn: Connection, status: "online" | "away"): Promise<void> {
    for (const workspaceId of conn.workspaces) {
      const change = presence.set(workspaceId, conn.user.id, conn.id, status);
      if (change) {
        await deps.bus.publish(
          "presence.changed",
          { workspaceId, userId: change.userId, status: change.status },
          { actor: { type: "user", id: conn.user.id } },
        );
      }
    }
  }

  async function leaveWorkspace(conn: Connection, workspaceId: string): Promise<void> {
    const change = presence.leave(workspaceId, conn.user.id, conn.id);
    if (change) {
      await deps.bus.publish(
        "presence.changed",
        { workspaceId, userId: change.userId, status: change.status },
        { actor: { type: "user", id: conn.user.id } },
      );
    }
  }

  async function typing(
    conn: Connection,
    op: Extract<WsClientOp, { op: "typing" }>,
  ): Promise<void> {
    const key = `${op.channelId}:${op.threadRootId ?? ""}`;
    const now = Date.now();
    if (now - (conn.lastTyping.get(key) ?? 0) < TYPING_INTERVAL_MS) return;
    conn.lastTyping.set(key, now);
    const topic = `channel:${op.channelId}`;
    const grant = await authorizeTopic(deps.db, conn.user.id, {
      kind: "channel",
      id: op.channelId,
      topic,
    });
    if (!grant.allowed || !grant.workspaceId) {
      fail(conn, "typing", grant.allowed ? "not_found" : grant.code, "channel not found");
      return;
    }
    await deps.bus.publish(
      "typing",
      {
        workspaceId: grant.workspaceId,
        channelId: op.channelId,
        ...(op.threadRootId ? { threadRootId: op.threadRootId } : {}),
        memberType: "user",
        memberId: conn.user.id,
      },
      { actor: { type: "user", id: conn.user.id }, topics: [topic] },
    );
  }

  function resume(conn: Connection, op: Extract<WsClientOp, { op: "resume" }>): void {
    if (!conn.subscriptions.has(op.topic)) {
      fail(conn, "resume", "validation", "subscribe to the topic before resuming", op.topic);
      return;
    }
    const result = deps.bus.replay(op.topic, op.after_seq);
    if (result.kind === "unknown_topic") {
      // Nothing was ever published on it; the client is up to date.
      control(conn, WS_CONTROL_TYPES.subscribed, { topic: op.topic, resumed: true }, op.topic, 0);
      return;
    }
    if (result.kind === "gap") {
      control(
        conn,
        WS_CONTROL_TYPES.resync,
        { oldest: result.oldest, latest: result.latest },
        op.topic,
        result.latest,
      );
      return;
    }
    for (const { seq, event } of result.events) fanout(conn, op.topic, event, seq);
    control(
      conn,
      WS_CONTROL_TYPES.subscribed,
      { topic: op.topic, resumed: true, replayed: result.events.length },
      op.topic,
      deps.bus.seq(op.topic),
    );
  }

  async function handle(conn: Connection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(conn, "?", "validation", "messages must be JSON");
      return;
    }
    const result = wsClientOpSchema.safeParse(parsed);
    if (!result.success) {
      const op =
        typeof (parsed as { op?: unknown })?.op === "string"
          ? String((parsed as { op: string }).op)
          : "?";
      fail(conn, op, "validation", result.error.issues.map((i) => i.message).join("; "));
      return;
    }
    const op = result.data;
    switch (op.op) {
      case "subscribe":
        return subscribe(conn, op.topics);
      case "unsubscribe":
        return unsubscribe(conn, op.topics);
      case "ping":
        control(conn, WS_CONTROL_TYPES.pong, { ts: op.ts ?? null });
        return;
      case "presence":
        return setPresence(conn, op.status);
      case "typing":
        return typing(conn, op);
      case "resume":
        resume(conn, op);
        return;
    }
  }

  async function close(conn: Connection): Promise<void> {
    connections.delete(conn.id);
    for (const off of conn.subscriptions.values()) off();
    conn.subscriptions.clear();
    for (const workspaceId of conn.workspaces) await leaveWorkspace(conn, workspaceId);
    conn.workspaces.clear();
  }

  /** The Hono handler for GET /api/ws; the caller must already be authenticated (checked in app.ts). */
  const handler = upgradeWebSocket((c: Context<AppEnv>) => {
    const user = c.get("user");
    const log = c.get("log");
    let conn: Connection | undefined;
    return {
      onOpen(_evt, ws) {
        if (!user) {
          ws.close(1008, "authentication required");
          return;
        }
        conn = {
          id: Bun.randomUUIDv7(),
          user,
          ws,
          subscriptions: new Map(),
          workspaces: new Set(),
          lastTyping: new Map(),
        };
        connections.set(conn.id, conn);
        control(conn, WS_CONTROL_TYPES.hello, {
          userId: user.id,
          replayBuffer: WS_REPLAY_BUFFER,
          connectionId: conn.id,
        });
      },
      onMessage(evt) {
        if (!conn) return;
        const active = conn;
        const data = typeof evt.data === "string" ? evt.data : "";
        handle(active, data).catch((error: unknown) => {
          log.error({ err: error, connection: active.id }, "ws op failed");
          fail(active, "?", "internal", "internal error");
        });
      },
      onClose() {
        if (!conn) return;
        const closing = conn;
        conn = undefined;
        close(closing).catch((error: unknown) =>
          log.error({ err: error, connection: closing.id }, "ws close failed"),
        );
      },
    };
  });

  return {
    handler,
    websocket,
    presence,
    /** Open connections (for /api/health details and tests). */
    get size() {
      return connections.size;
    },
  };
}

export type WsServer = ReturnType<typeof createWsServer>;
