/**
 * EngineEvent (spec §3.3): the union every engine adapter translates into, persisted to session_events
 * with a monotonic seq and republished on session:<id>.
 */
import { z } from "zod";

export const fileDiffSchema = z
  .object({
    path: z.string().min(1),
    oldPath: z.string().min(1).optional(),
    /** Unified diff text for this file. */
    patch: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    status: z.enum(["added", "modified", "deleted", "renamed"]).optional(),
  })
  .strict();
export type FileDiff = z.infer<typeof fileDiffSchema>;

export const engineEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }).strict(),
  z
    .object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), args: z.unknown() })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      id: z.string(),
      output: z.string(),
      diff: z.array(fileDiffSchema).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("permission"), id: z.string(), tool: z.string(), args: z.unknown() })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z.object({ type: z.literal("error"), message: z.string() }).strict(),
]);
export type EngineEvent = z.infer<typeof engineEventSchema>;

export const permissionAnswerSchema = z.enum(["allow", "always", "deny"]);
export type PermissionAnswer = z.infer<typeof permissionAnswerSchema>;

export const sessionModeSchema = z.enum(["plan", "build"]);
export type SessionMode = z.infer<typeof sessionModeSchema>;

export const engineIdSchema = z.enum([
  "acp",
  "opencode",
  "cli-harness",
  "native",
  "hermes",
  "cli",
  "native-code",
]);
export type EngineId = z.infer<typeof engineIdSchema>;

/** Which model a session runs on: a provider and model id, optionally through a model profile. */
export const modelRefSchema = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    profileId: z.uuid().optional(),
  })
  .strict();
export type ModelRef = z.infer<typeof modelRefSchema>;

/** What a person sends to a session: text plus file ids attached to the turn. */
export const userTurnSchema = z
  .object({
    text: z.string().min(1).max(100_000),
    attachments: z.array(z.string()).max(32).optional(),
  })
  .strict();
export type UserTurn = z.infer<typeof userTurnSchema>;

/**
 * The person's side of the transcript (task 1.8, ADR-0074): the turn that starts a round is stored
 * in session_events beside the engine's events, so a replay carries the whole conversation.
 */
export const turnEventSchema = z
  .object({
    type: z.literal("turn"),
    text: z.string(),
    attachments: z.array(z.string()).optional(),
    mode: sessionModeSchema,
    userId: z.uuid(),
  })
  .strict();
export type TurnEvent = z.infer<typeof turnEventSchema>;

/** Everything session_events stores: engine events and turns. */
export const sessionEventSchema = z.discriminatedUnion("type", [
  ...engineEventSchema.options,
  turnEventSchema,
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/**
 * A session's life (task 1.8): idle between rounds, running while an engine answers, needs_you while
 * a permission waits, error after an engine error, ended once closed.
 */
export const SESSION_STATUSES = ["idle", "running", "needs_you", "error", "ended"] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** A stored session event row: the event plus its monotonic position. */
export const sessionEventRecordSchema = z
  .object({
    sessionId: z.uuid(),
    seq: z.number().int().nonnegative(),
    ts: z.iso.datetime(),
    event: sessionEventSchema,
  })
  .strict();
export type SessionEventRecord = z.infer<typeof sessionEventRecordSchema>;
