/**
 * The runner protocol (spec §7.6, wss:///api/runner): JSON-RPC 2.0 over one control WebSocket. Every
 * api → runner request carries workspace_id, user_id, and a per-request capability token the runner
 * verifies; a local runner refuses requests for users other than its owner unless a grant is attached.
 */
import { z } from "zod";
import { engineEventSchema, sessionModeSchema } from "./engine.ts";

export const jsonRpcIdSchema = z.union([z.string(), z.number().int()]);

/** Fields every api → runner request carries (spec §7.6). */
export const runnerRequestContextSchema = z.object({
  workspace_id: z.uuid(),
  user_id: z.uuid(),
  /** Per-request capability token, verified by the runner against the api's signing key. */
  cap: z.string().min(1),
  /** Present when the api acts for a user other than a local runner's owner. */
  grant: z.string().min(1).optional(),
});
export type RunnerRequestContext = z.infer<typeof runnerRequestContextSchema>;

const ctx = runnerRequestContextSchema.shape;
const modelRef = z.object({
  provider: z.string(),
  modelId: z.string(),
  profileId: z.uuid().optional(),
});

/** Runner → api. */
export const runnerToApiParams = {
  "runner.register": z.object({
    name: z.string().min(1),
    kind: z.enum(["hosted", "local", "remote"]),
    capabilities: z.record(z.string(), z.unknown()),
    versions: z.record(z.string(), z.string()),
  }),
  "runner.heartbeat": z.object({
    load: z.object({ cpu: z.number().min(0), memoryMb: z.number().nonnegative() }).partial(),
    sessions: z.array(z.uuid()),
  }),
  "ports.changed": z.object({
    ports: z.array(
      z.object({ port: z.number().int().min(1).max(65535), pid: z.number().int().optional() }),
    ),
  }),
  "session.event": z.object({ session_id: z.uuid(), event: engineEventSchema }),
  "pty.data": z.object({ pty_id: z.string(), data: z.string() }),
  "pty.exit": z.object({ pty_id: z.string(), code: z.number().int() }),
  "fs.changed": z.object({
    project: z.uuid(),
    paths: z.array(z.string()),
    kind: z.enum(["create", "change", "delete"]),
  }),
} as const;

/** Api → runner. */
export const apiToRunnerParams = {
  "session.create": z.object({
    ...ctx,
    session_id: z.uuid(),
    project: z.uuid(),
    engine: z.string(),
    model: modelRef,
    mode: sessionModeSchema,
    worktree: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  "session.send": z.object({
    ...ctx,
    session_id: z.uuid(),
    turn: z.object({ text: z.string(), attachments: z.array(z.string()).optional() }),
    mode: sessionModeSchema.optional(),
  }),
  "session.permission": z.object({
    ...ctx,
    session_id: z.uuid(),
    permission_id: z.string(),
    answer: z.enum(["allow", "always", "deny"]),
  }),
  "session.cancel": z.object({ ...ctx, session_id: z.uuid() }),
  "session.checkpoint": z.object({ ...ctx, session_id: z.uuid(), turn: z.number().int() }),
  "session.restore": z.object({ ...ctx, session_id: z.uuid(), turn: z.number().int() }),
  "pty.open": z.object({
    ...ctx,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    cwd: z.string(),
    user: z.string(),
  }),
  "pty.input": z.object({ ...ctx, pty_id: z.string(), data: z.string() }),
  "pty.resize": z.object({
    ...ctx,
    pty_id: z.string(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  "pty.close": z.object({ ...ctx, pty_id: z.string() }),
  "fs.list": z.object({ ...ctx, project: z.uuid(), path: z.string() }),
  "fs.read": z.object({ ...ctx, project: z.uuid(), path: z.string() }),
  "fs.write": z.object({
    ...ctx,
    project: z.uuid(),
    path: z.string(),
    content: z.string(),
    /** base64 for binary content (uploads); utf8 otherwise. */
    encoding: z.enum(["utf8", "base64"]).optional(),
  }),
  "fs.stat": z.object({ ...ctx, project: z.uuid(), path: z.string() }),
  "fs.search": z.object({
    ...ctx,
    project: z.uuid(),
    query: z.string(),
    glob: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
  "git.status": z.object({ ...ctx, project: z.uuid() }),
  "git.diff": z.object({ ...ctx, project: z.uuid(), ref: z.string().optional() }),
  "git.commit": z.object({
    ...ctx,
    project: z.uuid(),
    message: z.string(),
    paths: z.array(z.string()).optional(),
  }),
  "git.push": z.object({ ...ctx, project: z.uuid(), branch: z.string().optional() }),
  "git.branch": z.object({
    ...ctx,
    project: z.uuid(),
    name: z.string().optional(),
    create: z.boolean().optional(),
  }),
  // Additive (ADR-0069): a project's directory on the runner, created from nothing, a clone, or an
  // upload, with .perch/project.json and devcontainer.json read back.
  "project.setup": z.object({
    ...ctx,
    project: z.uuid(),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("empty"), defaultBranch: z.string().min(1).optional() }),
      z.object({ kind: z.literal("upload") }),
      z.object({
        kind: z.literal("clone"),
        url: z.string().min(1),
        branch: z.string().min(1).optional(),
        auth: z
          .discriminatedUnion("kind", [
            z.object({
              kind: z.literal("token"),
              username: z.string().min(1).optional(),
              token: z.string().min(1),
            }),
            z.object({ kind: z.literal("ssh"), privateKey: z.string().min(1) }),
          ])
          .optional(),
      }),
    ]),
    /** Run devcontainer.json's postCreateCommand after a clone or upload (default true). */
    postCreate: z.boolean().optional(),
  }),
  "project.remove": z.object({ ...ctx, project: z.uuid() }),
  "worktree.create": z.object({
    ...ctx,
    project: z.uuid(),
    branch: z.string(),
    base: z.string().optional(),
  }),
  "worktree.remove": z.object({ ...ctx, project: z.uuid(), branch: z.string() }),
  "ports.list": z.object({ ...ctx }),
  "http.open": z.object({
    ...ctx,
    port: z.number().int().min(1).max(65535),
    path: z.string(),
    method: z.string(),
    headers: z.array(z.tuple([z.string(), z.string()])),
    upgrade: z.boolean().optional(),
    protocols: z.string().nullable().optional(),
  }),
  "mcp.spawn": z.object({ ...ctx, command: z.string(), args: z.array(z.string()) }),
  exec: z.object({
    ...ctx,
    command: z.string(),
    cwd: z.string(),
    timeout: z.number().int().positive(),
  }),
} as const;

/** The api's answer to `runner.register` (a JSON-RPC request, the first message on the socket). */
export const runnerRegisterResultSchema = z
  .object({
    runner_id: z.uuid(),
    /** The per-connection secret the api mints capability tokens with (runner-cap.ts). */
    cap_secret: z.string().min(1),
    heartbeat_ms: z.number().int().positive(),
    /** The user a local or remote runner serves; null for hosted runners. */
    owner_user_id: z.uuid().nullable(),
  })
  .strict();
export type RunnerRegisterResult = z.infer<typeof runnerRegisterResultSchema>;

/** Heartbeat period the api asks for; three missed heartbeats close the connection. */
export const RUNNER_HEARTBEAT_MS = 15_000;
/** A runner must register this soon after the socket opens. */
export const RUNNER_REGISTER_TIMEOUT_MS = 5_000;

export type RunnerToApiMethod = keyof typeof runnerToApiParams & string;
export type ApiToRunnerMethod = keyof typeof apiToRunnerParams & string;
export type RunnerMethod = RunnerToApiMethod | ApiToRunnerMethod;

/** What project.setup returns: the checkout facts and the two files, parsed but not yet validated. */
export const projectSetupResultSchema = z
  .object({
    path: z.string(),
    defaultBranch: z.string().nullable(),
    head: z.string().nullable(),
    config: z.unknown().nullable(),
    configError: z.string().optional(),
    devcontainer: z.unknown().nullable(),
    devcontainerError: z.string().optional(),
    postCreate: z
      .object({ command: z.string(), exitCode: z.number().int(), output: z.string() })
      .optional(),
  })
  .strict();
export type ProjectSetupResult = z.infer<typeof projectSetupResultSchema>;

/** Methods whose result is a stream token for a data socket at /api/runner/stream/{token}. */
export const STREAM_TOKEN_METHODS = ["pty.open", "http.open", "mcp.spawn"] as const;
export const streamTokenResultSchema = z.object({ stream_token: z.string().min(1) }).strict();

export const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema,
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();
export const jsonRpcNotificationSchema = z
  .object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown().optional() })
  .strict();
export const jsonRpcErrorSchema = z
  .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
  .strict();
export const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema.nullable(),
    result: z.unknown().optional(),
    error: jsonRpcErrorSchema.optional(),
  })
  .strict();
export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcResponseSchema,
]);
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Perch: capability token missing or invalid. */
  unauthorized: -32001,
  /** Perch: a local runner refusing a user other than its owner without a grant. */
  forbidden: -32003,
  /** Perch: policy engine denied the request (exec, git push, …). */
  policyViolation: -32451,
} as const;

/** Parses a request's params against the method's schema. */
export function parseRunnerParams<M extends RunnerMethod>(
  method: M,
  params: unknown,
): z.infer<(typeof runnerToApiParams & typeof apiToRunnerParams)[M]> {
  const all = { ...runnerToApiParams, ...apiToRunnerParams };
  return all[method].parse(params) as z.infer<
    (typeof runnerToApiParams & typeof apiToRunnerParams)[M]
  >;
}

export function isRunnerMethod(method: string): method is RunnerMethod {
  return Object.hasOwn(runnerToApiParams, method) || Object.hasOwn(apiToRunnerParams, method);
}
