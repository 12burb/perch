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

/** A stored session event row: the engine event plus its monotonic position. */
export const sessionEventRecordSchema = z
  .object({
    sessionId: z.uuid(),
    seq: z.number().int().nonnegative(),
    ts: z.iso.datetime(),
    event: engineEventSchema,
  })
  .strict();
export type SessionEventRecord = z.infer<typeof sessionEventRecordSchema>;
