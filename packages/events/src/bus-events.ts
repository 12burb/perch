/**
 * The bus event catalog (spec §7.7). Every state change in Perch emits exactly one of these; WS fan-out,
 * inbox, webhooks, and audit subscribe. Payload schemas are Zod so publishers are validated at the boundary
 * and subscribers get typed events.
 */
import { z } from "zod";

const uuid = z.uuid();
const memberType = z.enum(["user", "bot"]);
const actorType = z.enum(["user", "bot", "system", "runner"]);

export const actorSchema = z.object({ type: actorType, id: uuid.optional() }).strict();
export type Actor = z.infer<typeof actorSchema>;

const ws = { workspaceId: uuid };

export const busEventPayloads = {
  "workspace.updated": z.object({ ...ws, changes: z.array(z.string()).optional() }),
  "member.added": z.object({ ...ws, userId: uuid, role: z.string() }),
  "member.removed": z.object({ ...ws, userId: uuid }),
  "member.role_changed": z.object({
    ...ws,
    userId: uuid,
    role: z.string(),
    previousRole: z.string(),
  }),
  "project.created": z.object({ ...ws, projectId: uuid }),
  "project.updated": z.object({ ...ws, projectId: uuid, changes: z.array(z.string()).optional() }),
  "project.deleted": z.object({ ...ws, projectId: uuid }),
  // workspaceId is null for the shared hosted runner (PERCH_RUNNER_MODE=shared, ADR-0067).
  "runner.registered": z.object({
    workspaceId: uuid.nullable(),
    runnerId: uuid,
    kind: z.enum(["hosted", "local", "remote"]),
  }),
  "runner.online": z.object({ workspaceId: uuid.nullable(), runnerId: uuid }),
  "runner.offline": z.object({
    workspaceId: uuid.nullable(),
    runnerId: uuid,
    reason: z.string().optional(),
  }),
  "channel.created": z.object({ ...ws, channelId: uuid, type: z.string() }),
  "channel.updated": z.object({ ...ws, channelId: uuid, changes: z.array(z.string()).optional() }),
  "channel.archived": z.object({ ...ws, channelId: uuid }),
  "message.created": z.object({
    ...ws,
    channelId: uuid,
    messageId: uuid,
    threadRootId: uuid.optional(),
    authorType: z.enum(["user", "bot", "system"]),
    authorId: uuid,
  }),
  "message.updated": z.object({ ...ws, channelId: uuid, messageId: uuid }),
  "message.deleted": z.object({ ...ws, channelId: uuid, messageId: uuid }),
  "reaction.added": z.object({
    ...ws,
    channelId: uuid,
    messageId: uuid,
    emoji: z.string(),
    memberType,
    memberId: uuid,
  }),
  "reaction.removed": z.object({
    ...ws,
    channelId: uuid,
    messageId: uuid,
    emoji: z.string(),
    memberType,
    memberId: uuid,
  }),
  "thread.facts_updated": z.object({ ...ws, threadRootId: uuid, key: z.string() }),
  "read_state.updated": z.object({
    ...ws,
    userId: uuid,
    channelId: uuid,
    lastReadMessageId: uuid.optional(),
  }),
  "presence.changed": z.object({
    ...ws,
    userId: uuid,
    status: z.enum(["online", "away", "offline"]),
  }),
  typing: z.object({
    ...ws,
    channelId: uuid,
    threadRootId: uuid.optional(),
    memberType,
    memberId: uuid,
  }),
  "bot.installed": z.object({ ...ws, botId: uuid, channelId: uuid }),
  "bot.uninstalled": z.object({ ...ws, botId: uuid, channelId: uuid }),
  "bot.run_started": z.object({ ...ws, botId: uuid, runId: uuid, trigger: z.string() }),
  "bot.run_finished": z.object({ ...ws, botId: uuid, runId: uuid, costUsd: z.number().optional() }),
  "bot.run_failed": z.object({ ...ws, botId: uuid, runId: uuid, error: z.string() }),
  /**
   * A bot wants to call a tool a person has to say yes to (spec §3.5 "tool marked
   * requires_permission returns pending + inbox item, completes on approval"; task 3.6).
   */
  "bot.permission_requested": z.object({
    ...ws,
    botId: uuid,
    callId: uuid,
    channelId: uuid,
    /** `provider/tool`, which is what the person is being asked about. */
    tool: z.string(),
    /** Whose turn asked for it; null when a schedule or a webhook did, and the owner is asked. */
    requestedBy: uuid.nullable(),
  }),
  "bot.permission_answered": z.object({
    ...ws,
    botId: uuid,
    callId: uuid,
    decision: z.enum(["approved", "denied"]),
  }),
  "bot.chain_hop": z.object({
    ...ws,
    chainId: uuid,
    threadRootId: uuid,
    hop: z.number().int().nonnegative(),
    fromType: memberType,
    fromId: uuid,
    toBotId: uuid,
    mode: z.enum(["consult", "handoff", "fanout"]),
  }),
  "bot.chain_breaker": z.object({
    ...ws,
    chainId: uuid,
    threadRootId: uuid,
    reason: z.string(),
  }),
  "session.created": z.object({
    ...ws,
    sessionId: uuid,
    projectId: uuid,
    userId: uuid,
    engine: z.string(),
  }),
  /** A person's turn started a round (task 1.8, ADR-0074); the text itself is in the replay. */
  "session.turn": z.object({
    ...ws,
    sessionId: uuid,
    seq: z.number().int(),
    userId: uuid,
    preview: z.string().max(200),
  }),
  /** The session's status changed (idle, running, needs_you, error, ended). */
  "session.status": z.object({ ...ws, sessionId: uuid, status: z.string() }),
  "session.delta": z.object({ ...ws, sessionId: uuid, seq: z.number().int(), delta: z.string() }),
  "session.tool_call": z.object({
    ...ws,
    sessionId: uuid,
    seq: z.number().int(),
    callId: z.string(),
    name: z.string(),
  }),
  "session.tool_result": z.object({
    ...ws,
    sessionId: uuid,
    seq: z.number().int(),
    callId: z.string(),
    changedFiles: z.array(z.string()).optional(),
  }),
  "session.permission_requested": z.object({
    ...ws,
    sessionId: uuid,
    seq: z.number().int(),
    permissionId: z.string(),
    tool: z.string(),
  }),
  "session.permission_answered": z.object({
    ...ws,
    sessionId: uuid,
    permissionId: z.string(),
    answer: z.enum(["allow", "always", "deny"]),
    userId: uuid.optional(),
  }),
  "session.usage": z.object({
    ...ws,
    sessionId: uuid,
    seq: z.number().int(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  "session.done": z.object({ ...ws, sessionId: uuid, seq: z.number().int() }),
  "session.error": z.object({ ...ws, sessionId: uuid, seq: z.number().int(), message: z.string() }),
  "diff.applied": z.object({
    ...ws,
    sessionId: uuid,
    turn: z.number().int().optional(),
    files: z.array(z.string()),
  }),
  "checkpoint.created": z.object({
    ...ws,
    sessionId: uuid,
    turn: z.number().int(),
    gitRef: z.string(),
  }),
  "checkpoint.restored": z.object({
    ...ws,
    sessionId: uuid,
    turn: z.number().int(),
    gitRef: z.string(),
  }),
  "connection.created": z.object({ ...ws, connectionId: uuid, provider: z.string() }),
  "connection.refreshed": z.object({ ...ws, connectionId: uuid, provider: z.string() }),
  "connection.revoked": z.object({ ...ws, connectionId: uuid, provider: z.string() }),
  "connection.failed": z.object({
    ...ws,
    connectionId: uuid,
    provider: z.string(),
    error: z.string(),
  }),
  "connection.grant_added": z.object({
    ...ws,
    connectionId: uuid,
    grantId: uuid,
    subjectType: z.enum(["bot", "automation", "session"]),
    subjectId: uuid,
  }),
  "connection.grant_removed": z.object({ ...ws, connectionId: uuid, grantId: uuid }),
  /** A deploy asked for from the IDE (spec §5.5; task 2.15); the card in the thread is its record. */
  "deploy.started": z.object({
    ...ws,
    projectId: uuid,
    provider: z.string(),
    deploymentId: z.string(),
    target: z.enum(["preview", "production"]),
    state: z.enum(["queued", "building", "ready", "error", "canceled"]),
    url: z.string().optional(),
    messageId: uuid,
  }),
  "tools.called": z.object({
    ...ws,
    connectionId: uuid.optional(),
    tool: z.string(),
    callerType: actorType,
    callerId: uuid.optional(),
    argsHash: z.string(),
    outcome: z.enum(["ok", "error", "pending", "denied"]),
  }),
  "preview.port_detected": z.object({
    ...ws,
    runnerId: uuid,
    projectId: uuid.optional(),
    port: z.number().int().min(1).max(65535),
  }),
  "preview.share_created": z.object({
    ...ws,
    shareId: uuid,
    projectId: uuid,
    port: z.number().int(),
  }),
  "preview.share_revoked": z.object({ ...ws, shareId: uuid }),
  "work_item.created": z.object({ ...ws, projectId: uuid, workItemId: uuid }),
  "work_item.updated": z.object({
    ...ws,
    projectId: uuid,
    workItemId: uuid,
    changes: z.array(z.string()).optional(),
  }),
  "work_item.state_changed": z.object({
    ...ws,
    projectId: uuid,
    workItemId: uuid,
    state: z.string(),
    previousState: z.string(),
  }),
  "work_item.assigned": z.object({
    ...ws,
    projectId: uuid,
    workItemId: uuid,
    assigneeType: z.string().optional(),
    assigneeId: uuid.optional(),
  }),
  /**
   * The merge queue (spec §5.7; task 3.15). Additive to §7.7's catalog (ADR-0131): the queue is
   * named in §5.7 and its events are not, and a queue nobody can watch is a queue you have to
   * poll.
   */
  "merge.queued": z.object({
    ...ws,
    projectId: uuid,
    entryId: uuid,
    branch: z.string(),
    position: z.number().int(),
  }),
  "merge.landing": z.object({ ...ws, projectId: uuid, entryId: uuid, branch: z.string() }),
  "merge.landed": z.object({
    ...ws,
    projectId: uuid,
    entryId: uuid,
    branch: z.string(),
    head: z.string(),
  }),
  "merge.failed": z.object({
    ...ws,
    projectId: uuid,
    entryId: uuid,
    branch: z.string(),
    failure: z.string(),
  }),
  "intake.received": z.object({ ...ws, projectId: uuid, workItemId: uuid, source: z.string() }),
  "intake.accepted": z.object({ ...ws, projectId: uuid, workItemId: uuid }),
  "intake.declined": z.object({ ...ws, projectId: uuid, workItemId: uuid }),
  "inbox.item_created": z.object({ ...ws, userId: uuid, inboxItemId: uuid, kind: z.string() }),
  "inbox.resolved": z.object({ ...ws, userId: uuid, inboxItemId: uuid }),
  "policy.violation": z.object({
    ...ws,
    rule: z.string(),
    subjectType: actorType,
    subjectId: uuid.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  "usage.recorded": z.object({
    ...ws,
    usageEventId: uuid,
    actorType,
    actorId: uuid.optional(),
    provider: z.string(),
    modelId: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  "budget.warning": z.object({
    ...ws,
    subjectType: z.string(),
    subjectId: uuid,
    spentUsd: z.number(),
    limitUsd: z.number(),
  }),
  "budget.exceeded": z.object({
    ...ws,
    subjectType: z.string(),
    subjectId: uuid,
    spentUsd: z.number(),
    limitUsd: z.number(),
  }),
  "webhook.received": z.object({ ...ws, webhookId: uuid, provider: z.string() }),
  "webhook.delivered": z.object({ ...ws, webhookId: uuid, url: z.string() }),
  "webhook.failed": z.object({ ...ws, webhookId: uuid, url: z.string(), error: z.string() }),
  "audit.logged": z.object({
    ...ws,
    auditId: uuid,
    action: z.string(),
    actorType,
    actorId: uuid.optional(),
    targetType: z.string(),
    targetId: uuid.optional(),
  }),
} as const;

export type BusEventPayloads = typeof busEventPayloads;
export type BusEventName = keyof BusEventPayloads & string;
export type BusPayload<T extends BusEventName> = z.infer<BusEventPayloads[T]>;

export const BUS_EVENT_NAMES = Object.keys(busEventPayloads) as BusEventName[];

export function isBusEventName(name: string): name is BusEventName {
  return Object.hasOwn(busEventPayloads, name);
}

/** Request facts the audit log keeps beside the actor (never a token, never a body). */
export const eventMetaSchema = z
  .object({ requestId: z.string().optional(), ip: z.string().optional() })
  .strict();
export type EventMeta = z.infer<typeof eventMetaSchema>;

/** The envelope every published event travels in. */
export type BusEvent<T extends BusEventName = BusEventName> = {
  id: string;
  type: T;
  ts: string;
  payload: BusPayload<T>;
  actor?: Actor;
  meta?: EventMeta;
  /** WS topics the event fans out to (ws:<id>, channel:<id>, session:<id>, inbox:<user>). */
  topics: string[];
};

export const busEventEnvelopeSchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    ts: z.iso.datetime(),
    payload: z.unknown(),
    actor: actorSchema.optional(),
    meta: eventMetaSchema.optional(),
    topics: z.array(z.string()),
  })
  .strict();

/** Validates a payload for a named event; throws a ZodError on a bad payload. */
export function parseBusPayload<T extends BusEventName>(type: T, payload: unknown): BusPayload<T> {
  return busEventPayloads[type].parse(payload) as BusPayload<T>;
}
