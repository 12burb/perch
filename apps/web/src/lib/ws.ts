/**
 * The /api/ws client (spec §7.2): one socket per tab, topic subscriptions with per-topic seqs,
 * resume after a reconnect, presence heartbeat, and a presence store React can subscribe to.
 */
import type { WsClientOp, WsServerEnvelope } from "@perch/events";
import { useSyncExternalStore } from "react";

type Listener = (envelope: WsServerEnvelope) => void;
type PresenceStatus = "online" | "away";
export type PresenceMap = ReadonlyMap<string, PresenceStatus>;

const EMPTY: PresenceMap = new Map();

export class PerchSocket {
  private socket: WebSocket | null = null;
  private readonly topics = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly presence = new Map<string, Map<string, PresenceStatus>>();
  private readonly presenceListeners = new Set<() => void>();
  private snapshots = new Map<string, PresenceMap>();
  private status: PresenceStatus = "online";
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly url: string) {}

  start(): void {
    this.stopped = false;
    this.connect();
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.set(topic, 0);
    this.send({ op: "subscribe", topics: [topic] });
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    this.send({ op: "unsubscribe", topics: [topic] });
    const workspaceId = topic.startsWith("ws:") ? topic.slice(3) : null;
    if (workspaceId) {
      this.presence.delete(workspaceId);
      this.bumpPresence(workspaceId);
    }
  }

  typing(channelId: string, threadRootId?: string): void {
    this.send({ op: "typing", channelId, ...(threadRootId ? { threadRootId } : {}) });
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** React external store: who is online or away in a workspace. */
  presenceOf(workspaceId: string): PresenceMap {
    return this.snapshots.get(workspaceId) ?? EMPTY;
  }

  onPresence(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  private readonly onVisibility = () => {
    this.status = document.visibilityState === "hidden" ? "away" : "online";
    this.send({ op: "presence", status: this.status });
  };

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempt = 0;
      // Re-subscribe everything, resume from the last seq seen per topic, and announce presence.
      for (const [topic, seq] of this.topics) {
        this.send({ op: "subscribe", topics: [topic] });
        if (seq > 0) this.send({ op: "resume", topic, after_seq: seq });
      }
      this.send({ op: "presence", status: this.status });
    });
    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(String(event.data)) as WsServerEnvelope;
      this.handle(envelope);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private send(op: WsClientOp): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(op));
  }

  private handle(envelope: WsServerEnvelope): void {
    if (envelope.seq > 0 && this.topics.has(envelope.topic)) {
      const seen = this.topics.get(envelope.topic) ?? 0;
      if (envelope.seq > seen) this.topics.set(envelope.topic, envelope.seq);
    }
    if (envelope.type === "presence_snapshot") {
      const payload = envelope.payload as {
        workspaceId: string;
        users: Array<{ userId: string; status: PresenceStatus }>;
      };
      this.presence.set(
        payload.workspaceId,
        new Map(payload.users.map((u) => [u.userId, u.status])),
      );
      this.bumpPresence(payload.workspaceId);
    } else if (envelope.type === "presence.changed") {
      const payload = envelope.payload as {
        workspaceId: string;
        userId: string;
        status: PresenceStatus | "offline";
      };
      const users = this.presence.get(payload.workspaceId) ?? new Map<string, PresenceStatus>();
      if (payload.status === "offline") users.delete(payload.userId);
      else users.set(payload.userId, payload.status);
      this.presence.set(payload.workspaceId, users);
      this.bumpPresence(payload.workspaceId);
    } else if (envelope.type === "resync") {
      // The replay buffer no longer covers what this tab missed: callers refetch through REST.
      this.topics.set(envelope.topic, envelope.seq);
    }
    for (const listener of this.listeners) listener(envelope);
  }

  private bumpPresence(workspaceId: string): void {
    const users = this.presence.get(workspaceId);
    const next = new Map(this.snapshots);
    if (users) next.set(workspaceId, new Map(users));
    else next.delete(workspaceId);
    this.snapshots = next;
    for (const listener of this.presenceListeners) listener();
  }
}

let shared: PerchSocket | null = null;

/** The tab's socket; created on first use. */
export function getSocket(): PerchSocket {
  if (!shared) {
    const url = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/ws`;
    shared = new PerchSocket(url);
    shared.start();
  }
  return shared;
}

export function resetSocket(): void {
  shared?.stop();
  shared = null;
}

/** Presence in a workspace, kept subscribed while a component uses it. */
export function usePresence(workspaceId: string): PresenceMap {
  const socket = getSocket();
  socket.subscribe(`ws:${workspaceId}`);
  return useSyncExternalStore(
    (listener) => socket.onPresence(listener),
    () => socket.presenceOf(workspaceId),
    () => EMPTY,
  );
}
