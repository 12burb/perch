/**
 * @perch/bus: typed in-process pub/sub over the spec §7.7 catalog, with per-topic sequence numbers and a
 * replay buffer of the last WS_REPLAY_BUFFER events per topic (spec §7.2). The Redis adapter for
 * multi-node is a Phase 5 implementation of the same `Bus` interface (ADR-0005).
 */
import {
  type Actor,
  type BusEvent,
  type BusEventName,
  type BusPayload,
  type EventMeta,
  parseBusPayload,
  WS_REPLAY_BUFFER,
} from "@perch/events";

export type Unsubscribe = () => void;

export type EventHandler<T extends BusEventName = BusEventName> = (
  event: BusEvent<T>,
) => void | Promise<void>;

export type TopicHandler = (event: BusEvent, seq: number) => void | Promise<void>;

export type PublishOptions = {
  actor?: Actor;
  /** Request id and client ip for the audit log. */
  meta?: EventMeta;
  /** WS topics to fan out to; defaults to ws:<workspaceId> when the payload has a workspaceId. */
  topics?: string[];
  /** Override the event id (uuid v7 by default). */
  id?: string;
};

export type PublishResult = {
  event: BusEvent;
  /** The seq assigned per topic. */
  seqs: Record<string, number>;
};

export type ReplayResult =
  | { kind: "events"; events: Array<{ seq: number; event: BusEvent }> }
  /** after_seq is older than the buffer holds: the client must refetch. */
  | { kind: "gap"; oldest: number; latest: number }
  | { kind: "unknown_topic" };

export interface Bus {
  /** Validates the payload, stamps the envelope, assigns per-topic seqs, and delivers to subscribers. */
  publish<T extends BusEventName>(
    type: T,
    payload: BusPayload<T>,
    options?: PublishOptions,
  ): Promise<PublishResult>;
  /** Subscribe to one event type, or to everything with "*". */
  subscribe<T extends BusEventName>(type: T, handler: EventHandler<T>): Unsubscribe;
  subscribe(type: "*", handler: EventHandler): Unsubscribe;
  /** Subscribe to a WS topic (ws:<id>, channel:<id>, session:<id>, inbox:<user>). */
  subscribeTopic(topic: string, handler: TopicHandler): Unsubscribe;
  /** Latest seq on a topic (0 when nothing was published yet). */
  seq(topic: string): number;
  /** Events after `afterSeq` on a topic, from the replay buffer. */
  replay(topic: string, afterSeq: number): ReplayResult;
}

/** Topics kept at once by default: a busy instance's sessions in a day, with room to spare. */
export const MAX_TOPICS = 5000;

export type InProcessBusOptions = {
  replayBuffer?: number;
  /**
   * How many topics keep a replay buffer at once (ADR-0165). Every session publishes on a topic of
   * its own and nothing ever un-publishes, so without a bound the api's memory grew by one buffer
   * per session for the life of the process. Past the bound, the topic with nobody subscribed
   * whose last event is oldest is forgotten; a client resuming it gets `unknown_topic` and refetches.
   */
  maxTopics?: number;
  /** Called when a subscriber throws; publishing never fails because a subscriber did. */
  onError?: (error: unknown, event: BusEvent) => void;
  now?: () => Date;
  newId?: () => string;
};

type TopicState = {
  /** The publish counter at its last event, for choosing which topic to forget. */
  touched: number;
  seq: number;
  buffer: Array<{ seq: number; event: BusEvent }>;
  handlers: Set<TopicHandler>;
};

export function topicsFor(payload: unknown, explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) return [...new Set(explicit)];
  const workspaceId = (payload as { workspaceId?: unknown })?.workspaceId;
  return typeof workspaceId === "string" ? [`ws:${workspaceId}`] : [];
}

export class InProcessBus implements Bus {
  private readonly typeHandlers = new Map<string, Set<EventHandler>>();
  private readonly topics = new Map<string, TopicState>();
  private readonly replayBuffer: number;
  private readonly maxTopics: number;
  private publishes = 0;
  private readonly onError: (error: unknown, event: BusEvent) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: InProcessBusOptions = {}) {
    this.replayBuffer = options.replayBuffer ?? WS_REPLAY_BUFFER;
    this.maxTopics = options.maxTopics ?? MAX_TOPICS;
    this.onError =
      options.onError ??
      ((error, event) => {
        console.error(`[bus] subscriber failed for ${event.type}:`, error);
      });
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => Bun.randomUUIDv7());
  }

  async publish<T extends BusEventName>(
    type: T,
    payload: BusPayload<T>,
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    const parsed = parseBusPayload(type, payload);
    const topics = topicsFor(parsed, options.topics);
    const event: BusEvent<T> = {
      id: options.id ?? this.newId(),
      type,
      ts: this.now().toISOString(),
      payload: parsed,
      topics,
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.meta ? { meta: options.meta } : {}),
    };

    const seqs: Record<string, number> = {};
    const deliveries: Array<Promise<void>> = [];
    for (const topic of topics) {
      const state = this.topic(topic);
      state.seq += 1;
      const seq = state.seq;
      seqs[topic] = seq;
      state.buffer.push({ seq, event });
      if (state.buffer.length > this.replayBuffer)
        state.buffer.splice(0, state.buffer.length - this.replayBuffer);
      for (const handler of state.handlers)
        deliveries.push(this.deliver(() => handler(event, seq), event));
    }
    for (const handler of this.typeHandlers.get(type) ?? []) {
      deliveries.push(this.deliver(() => (handler as EventHandler<T>)(event), event));
    }
    for (const handler of this.typeHandlers.get("*") ?? []) {
      deliveries.push(this.deliver(() => handler(event), event));
    }
    await Promise.all(deliveries);
    return { event, seqs };
  }

  subscribe(type: string, handler: EventHandler): Unsubscribe {
    let set = this.typeHandlers.get(type);
    if (!set) {
      set = new Set();
      this.typeHandlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  subscribeTopic(topic: string, handler: TopicHandler): Unsubscribe {
    const state = this.topic(topic);
    state.handlers.add(handler);
    return () => {
      state.handlers.delete(handler);
    };
  }

  seq(topic: string): number {
    return this.topics.get(topic)?.seq ?? 0;
  }

  replay(topic: string, afterSeq: number): ReplayResult {
    const state = this.topics.get(topic);
    if (!state) return { kind: "unknown_topic" };
    const oldest = state.buffer[0]?.seq ?? state.seq + 1;
    if (afterSeq >= state.seq) return { kind: "events", events: [] };
    if (afterSeq < oldest - 1) return { kind: "gap", oldest, latest: state.seq };
    return { kind: "events", events: state.buffer.filter((e) => e.seq > afterSeq) };
  }

  private topic(topic: string): TopicState {
    let state = this.topics.get(topic);
    if (!state) {
      if (this.topics.size >= this.maxTopics) this.forgetOne();
      state = { seq: 0, buffer: [], handlers: new Set(), touched: ++this.publishes };
      this.topics.set(topic, state);
    } else {
      state.touched = ++this.publishes;
    }
    return state;
  }

  /** The topic with nobody subscribed whose last event is oldest; nothing, when all are live. */
  private forgetOne(): void {
    let oldest: [string, TopicState] | null = null;
    for (const entry of this.topics) {
      if (entry[1].handlers.size > 0) continue;
      if (!oldest || entry[1].touched < oldest[1].touched) oldest = entry;
    }
    if (oldest) this.topics.delete(oldest[0]);
  }

  private async deliver(run: () => void | Promise<void>, event: BusEvent): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.onError(error, event);
    }
  }
}

export function createBus(options?: InProcessBusOptions): Bus {
  return new InProcessBus(options);
}
