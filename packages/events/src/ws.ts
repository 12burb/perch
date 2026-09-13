/**
 * The client WebSocket protocol (spec §7.2, /api/ws): client ops and the server envelope.
 */
import { z } from "zod";

/** ws:<id>, channel:<id>, session:<id>, inbox:<user>. */
export const wsTopicSchema = z
  .string()
  .regex(/^(ws|channel|session|inbox):[A-Za-z0-9_-]+$/, "topic must be <kind>:<id>");
export type WsTopic = z.infer<typeof wsTopicSchema>;

export const wsClientOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), topics: z.array(wsTopicSchema).min(1).max(64) }).strict(),
  z
    .object({ op: z.literal("unsubscribe"), topics: z.array(wsTopicSchema).min(1).max(64) })
    .strict(),
  z.object({ op: z.literal("ping"), ts: z.number().optional() }).strict(),
  z
    .object({
      op: z.literal("typing"),
      channelId: z.uuid(),
      threadRootId: z.uuid().optional(),
    })
    .strict(),
  z.object({ op: z.literal("presence"), status: z.enum(["online", "away"]) }).strict(),
  z
    .object({
      op: z.literal("resume"),
      topic: wsTopicSchema,
      after_seq: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type WsClientOp = z.infer<typeof wsClientOpSchema>;

/** Server → client envelope: { type, topic, seq, ts, payload }. Control messages use the same shape. */
export const wsServerEnvelopeSchema = z
  .object({
    type: z.string(),
    topic: z.string(),
    seq: z.number().int().nonnegative(),
    ts: z.iso.datetime(),
    payload: z.unknown(),
  })
  .strict();
export type WsServerEnvelope<P = unknown> = Omit<
  z.infer<typeof wsServerEnvelopeSchema>,
  "payload"
> & {
  payload: P;
};

export const WS_CONTROL_TYPES = {
  pong: "pong",
  subscribed: "subscribed",
  unsubscribed: "unsubscribed",
  /** The replay buffer no longer holds after_seq; the client must refetch through REST. */
  resync: "resync",
  error: "error",
  hello: "hello",
  /** Sent on subscribing to ws:<id>: who is online in that workspace right now (ADR-0054). */
  presence_snapshot: "presence_snapshot",
} as const;
export type WsControlType = (typeof WS_CONTROL_TYPES)[keyof typeof WS_CONTROL_TYPES];

/** Payloads of the control envelopes (topic "" and seq 0 unless the message is about a topic). */
export const wsHelloPayloadSchema = z
  .object({ userId: z.uuid(), replayBuffer: z.number().int().positive(), connectionId: z.string() })
  .strict();
export const wsErrorPayloadSchema = z
  .object({ code: z.string(), message: z.string(), op: z.string().optional() })
  .strict();
export const wsPresenceSnapshotPayloadSchema = z
  .object({
    workspaceId: z.uuid(),
    users: z.array(z.object({ userId: z.uuid(), status: z.enum(["online", "away"]) })),
  })
  .strict();
export const wsResyncPayloadSchema = z
  .object({ oldest: z.number().int(), latest: z.number().int() })
  .strict();

/** Per-topic replay buffer size (spec §7.2: the last 1,000 events per topic). */
export const WS_REPLAY_BUFFER = 1000;
