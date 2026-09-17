/**
 * The runner protocol (spec §7.6, wss:///api/runner): JSON-RPC 2.0 over one control WebSocket. Every
 * api → runner request carries workspace_id, user_id, and a per-request capability token the runner
 * verifies; a local runner refuses requests for users other than its owner unless a grant is attached.
 */
import { z } from "zod";
import {
  engineEventSchema,
  fileDiffSchema,
  modelRefSchema,
  reasoningLevelSchema,
  sessionModeSchema,
} from "./engine.ts";

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

/** Runner → api. */
export const runnerToApiParams = {
  "runner.register": z.object({
    name: z.string().min(1),
    kind: z.enum(["hosted", "local", "remote"]),
    capabilities: z.record(z.string(), z.unknown()),
    versions: z.record(z.string(), z.string()),
    /**
     * The hostname the api can reach this runner's listening ports on, for previews (spec §5.6;
     * task 1.18). Only a runner that believes the api can route to it says so — a laptop behind
     * NAT stays silent and gets the tunnel of task 1.19 instead. Additive to §7.6 (ADR-0084).
     */
    preview_host: z.string().min(1).optional(),
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

/**
 * One MCP server a session may reach (spec §7.5): a name, Perch's gateway URL for it, and the
 * bearer Perch minted for this session. Never a provider's own token (AGENTS.md §1.6).
 */
/**
 * An MCP server a session may reach. §7.6 declares the HTTP shape — Perch's own gateway, with a
 * token minted for that session (task 1.17) — and task 3.21 adds the other transport MCP has: a
 * command the runner spawns beside the agent. Playwright's is the reason (spec §5.6 "@playwright/mcp
 * in the runner attached to sessions when a preview is open"): a browser has to be where the page
 * is, which is the runner, so there is nothing for the api to serve over HTTP (ADR-0139).
 */
export const sessionMcpServerSchema = z.union([
  z.object({
    name: z.string().min(1),
    url: z.url(),
    token: z.string().min(1),
  }),
  z.object({
    name: z.string().min(1),
    /** The executable, as the runner will find it. */
    command: z.string().min(1),
    args: z.array(z.string()).max(64).optional(),
    /** Never a credential: this is a command line on a machine Perch does not own. */
    env: z.record(z.string(), z.string()).optional(),
  }),
]);
export type SessionMcpServer = z.infer<typeof sessionMcpServerSchema>;

/** Api → runner. */
export const apiToRunnerParams = {
  "session.create": z.object({
    ...ctx,
    session_id: z.uuid(),
    project: z.uuid(),
    engine: z.string(),
    /**
     * Which program the engine runs: an ACP agent id (gemini, codex, …) or a CLI id. Absent means
     * the runner's default. Additive to §7.6 (ADR-0081): the model's provider names a model
     * provider now that brains exist, so it can no longer double as the program's name.
     */
    agent: z.string().optional(),
    model: modelRefSchema,
    mode: sessionModeSchema,
    worktree: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    /**
     * The MCP servers to put in front of the agent (spec §7.5; task 1.17). Every one is Perch's
     * own gateway, and every token is Perch's own minting: a provider's credential never reaches a
     * runner (AGENTS.md §1.6). Additive to §7.6 (ADR-0083).
     */
    mcp_servers: z.array(sessionMcpServerSchema).optional(),
  }),
  "session.send": z.object({
    ...ctx,
    session_id: z.uuid(),
    turn: z.object({ text: z.string(), attachments: z.array(z.string()).optional() }),
    mode: sessionModeSchema.optional(),
    /** How hard to think (task 2.18, ADR-0111): additive, and an engine that cannot say so ignores it. */
    reasoning: reasoningLevelSchema.optional(),
  }),
  "session.permission": z.object({
    ...ctx,
    session_id: z.uuid(),
    permission_id: z.string(),
    answer: z.enum(["allow", "always", "deny"]),
  }),
  "session.cancel": z.object({ ...ctx, session_id: z.uuid() }),
  /** `project` is additive (ADR-0079): the runner snapshots the project even when the session is not open here. */
  "session.checkpoint": z.object({
    ...ctx,
    session_id: z.uuid(),
    turn: z.number().int().positive(),
    project: z.uuid(),
  }),
  "session.restore": z.object({
    ...ctx,
    session_id: z.uuid(),
    turn: z.number().int().positive(),
    project: z.uuid(),
    /** Additive (ADR-0079): the checkpoint's commit, so a fork restores turns it inherited. */
    git_ref: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .optional(),
  }),
  "pty.open": z.object({
    ...ctx,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    cwd: z.string(),
    user: z.string(),
    /** Additive (ADR-0073): reattach to a shell the runner still holds (a reload, a closed drawer). */
    pty_id: z.string().optional(),
    /**
     * The project's own environment (spec §5.7 "injected into runner, previews, sessions"), so a
     * dev server started in this shell has what it needs. Additive to §7.6 (ADR-0103).
     */
    env: z.record(z.string(), z.string()).optional(),
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
    /** Additive (ADR-0070): the query is a literal unless regex is true; case follows ignoreCase. */
    regex: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
  }),
  "git.status": z.object({ ...ctx, project: z.uuid() }),
  /**
   * `ref` alone: the working tree (untracked files included, ignores honored) against the ref;
   * with `to`: one ref against another (ADR-0079). Neither: the working tree against HEAD, tracked
   * files only (task 1.5).
   */
  "git.diff": z.object({
    ...ctx,
    project: z.uuid(),
    ref: z.string().optional(),
    to: z.string().optional(),
  }),
  /** Additive (ADR-0079): a unified patch applied to the working tree, forward or in reverse. */
  "git.apply": z.object({
    ...ctx,
    project: z.uuid(),
    patch: z.string().min(1).max(4_000_000),
    reverse: z.boolean().optional(),
  }),
  "git.commit": z.object({
    ...ctx,
    project: z.uuid(),
    message: z.string(),
    paths: z.array(z.string()).optional(),
    /** Additive (ADR-0070): the committer identity; the api passes the member's. */
    author: z.object({ name: z.string().min(1), email: z.string().min(1) }).optional(),
  }),
  "git.push": z.object({
    ...ctx,
    project: z.uuid(),
    branch: z.string().optional(),
    /** Additive (ADR-0070): credentials for the push, the same shapes as a clone's. */
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
  "git.branch": z.object({
    ...ctx,
    project: z.uuid(),
    name: z.string().optional(),
    create: z.boolean().optional(),
  }),
  /**
   * Land a branch on another one (spec §5.7 "merge queue with rebase, conflict detection"; task
   * 3.15). Additive to §7.6's git.* list (ADR-0131): a queue has to rebase and fast-forward as one
   * operation on the runner, because two of them racing from the api side is the thing a queue
   * exists to prevent.
   */
  "git.merge": z.object({
    ...ctx,
    project: z.uuid(),
    branch: z.string(),
    /** The branch it lands on; the project's default branch when absent. */
    into: z.string().optional(),
    /** Rebase the branch onto `into` first. On by default: a queue lands in order. */
    rebase: z.boolean().optional(),
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
  /**
   * Re-read a project's checked-in files without touching the checkout (task 2.18, ADR-0111).
   * `.perch/project.json` is the project's own document: it changes with a pull or an edit, and
   * before this the only way Perch noticed was to set the project up again.
   */
  "project.config": z.object({ ...ctx, project: z.uuid() }),
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
  /**
   * A picture of a page the dev server is serving (spec §5.6 "Screenshot via headless Chromium in
   * the runner"; task 2.16, ADR-0108). Additive to §7.6: the runner is where the port is.
   */
  "preview.screenshot": z.object({
    ...ctx,
    port: z.number().int().min(1).max(65535),
    path: z.string(),
    width: z.number().int().min(200).max(4000).optional(),
    height: z.number().int().min(200).max(4000).optional(),
  }),
  /**
   * Start a project's dev server (task 4.8, ADR-0154). Additive to §7.6, for the same reason
   * `preview.screenshot` is: the process belongs on the machine the port is on. The runner holds it
   * and its log, so pressing Start twice is not two dev servers and closing the tab is not none.
   */
  "preview.start": z.object({
    ...ctx,
    project: z.uuid(),
    command: z.string().min(1),
    /** The project's own environment (spec §5.7), the way pty.open takes it. */
    env: z.record(z.string(), z.string()).optional(),
  }),
  /** Stop it again, with everything it started (task 4.8). */
  "preview.stop": z.object({ ...ctx, project: z.uuid() }),
  /** Is it running, and what has it said (task 4.8)? */
  "preview.status": z.object({ ...ctx, project: z.uuid() }),
  /**
   * An MCP server that runs inside the runner (spec §7.6 "mcp.spawn {command, args} → stream
   * token"; task 3.24). `project` is the same optional shape `exec` takes (ADR-0135): named, the
   * server runs in that project's directory, which is where a project's own tools expect to be.
   */
  "mcp.spawn": z.object({
    ...ctx,
    command: z.string(),
    args: z.array(z.string()),
    project: z.uuid().optional(),
  }),
  exec: z.object({
    ...ctx,
    command: z.string(),
    /**
     * Where to run it. §7.6 writes this as required; it is optional here, and a caller that names
     * a `project` instead gets that project's directory (task 3.18, ADR-0135). Which directory a
     * project is in is the runner's business, and an api that has to know is an api that has to
     * agree with it.
     */
    cwd: z.string().optional(),
    project: z.uuid().optional(),
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

/** What preview.screenshot returns (task 2.16): a PNG, base64, and the viewport it was taken at. */
export const screenshotResultSchema = z
  .object({
    png: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /**
     * What the page said while it was being looked at (task 3.21). Absent from a runner that
     * predates it; a preflight without it reports the picture and no verdict rather than a pass.
     */
    console: z
      .array(z.object({ level: z.string(), text: z.string() }))
      .max(500)
      .optional(),
    failed: z
      .array(z.object({ url: z.string(), status: z.number().int() }))
      .max(200)
      .optional(),
  })
  .strict();
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;

/**
 * What preview.start, preview.stop and preview.status all answer with (task 4.8): whether a dev
 * server is running for the project, and the tail of what it has written. `started` says whether
 * this call was the one that started it — pressing Start on a project that is already serving is
 * not an error, it is a no-op with a truthful answer.
 */
export const previewProcessSchema = z.object({
  running: z.boolean(),
  started: z.boolean(),
  pid: z.number().int().positive().nullable(),
  command: z.string().nullable(),
  started_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  /** The last few KiB of the dev server's output, so a failure to start says why. */
  log: z.string(),
});
export type PreviewProcess = z.infer<typeof previewProcessSchema>;

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

/** What project.config returns: the same two files, re-read where they are. */
export const projectConfigResultSchema = projectSetupResultSchema.pick({
  config: true,
  configError: true,
  devcontainer: true,
  devcontainerError: true,
});
export type ProjectConfigResult = z.infer<typeof projectConfigResultSchema>;

/** Results of the fs, git, ports, and exec methods (task 1.5, ADR-0070): what the api validates. */
export const fsEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
});
export const fsListResultSchema = z.object({ entries: z.array(fsEntrySchema) }).strict();
export const fsReadResultSchema = z
  .object({
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    size: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export const fsStatResultSchema = z
  .object({
    exists: z.boolean(),
    type: z.enum(["file", "dir", "symlink", "other"]).optional(),
    size: z.number().int().nonnegative().optional(),
    mtime: z.string().optional(),
  })
  .strict();
export const fsSearchResultSchema = z
  .object({
    matches: z.array(
      z.object({
        path: z.string(),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        text: z.string(),
      }),
    ),
    truncated: z.boolean(),
    tookMs: z.number().nonnegative(),
    engine: z.enum(["ripgrep", "builtin"]),
  })
  .strict();
export const gitStatusResultSchema = z
  .object({
    branch: z.string().nullable(),
    tracking: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    clean: z.boolean(),
    files: z.array(z.object({ path: z.string(), index: z.string(), workingTree: z.string() })),
  })
  .strict();
export const gitDiffResultSchema = z
  .object({
    diff: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        binary: z.boolean(),
      }),
    ),
    /** Additive (ADR-0079): the same diff as one FileDiff per file, hunks intact. */
    patches: z.array(fileDiffSchema),
  })
  .strict();
export const gitApplyResultSchema = z.object({ files: z.array(z.string()) }).strict();
export const sessionCheckpointResultSchema = z.object({ git_ref: z.string().min(1) }).strict();
export const sessionRestoreResultSchema = z
  .object({ git_ref: z.string().min(1), files: z.array(z.string()) })
  .strict();
export const gitCommitResultSchema = z
  .object({
    commit: z.string(),
    branch: z.string(),
    summary: z.object({
      changes: z.number().int().nonnegative(),
      insertions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  })
  .strict();
export const gitPushResultSchema = z
  .object({ pushed: z.literal(true), remote: z.string(), branch: z.string(), output: z.string() })
  .strict();
export const gitBranchResultSchema = z
  .object({
    current: z.string().nullable(),
    branches: z.array(z.string()),
    created: z.boolean().optional(),
  })
  .strict();
export const worktreeCreateResultSchema = z
  .object({ path: z.string(), branch: z.string() })
  .strict();
export const worktreeRemoveResultSchema = z.object({ removed: z.boolean() }).strict();

/** What landing a branch did, or why it could not (task 3.15). */
export const gitMergeResultSchema = z
  .object({
    merged: z.boolean(),
    /** The commit `into` now points at, when it moved. */
    head: z.string().optional(),
    /** True when git refused because the two sides disagree, rather than because of a mistake. */
    conflict: z.boolean().optional(),
    /** git's own words, for the card and for the agent that has to fix it. */
    reason: z.string().optional(),
  })
  .strict();

export type GitMergeResult = z.infer<typeof gitMergeResultSchema>;
export const portsListResultSchema = z
  .object({
    ports: z.array(
      z.object({ port: z.number().int().min(1).max(65535), pid: z.number().int().optional() }),
    ),
  })
  .strict();
export const execResultSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    durationMs: z.number().nonnegative(),
  })
  .strict();
export type ExecResult = z.infer<typeof execResultSchema>;

/** session.create's answer (task 1.9, ADR-0075): the engine's own session id, the agent, and its modes. */
export const sessionCreateResultSchema = z
  .object({
    engine_session_id: z.string().optional(),
    agent: z.object({ id: z.string(), name: z.string() }).optional(),
    modes: z
      .object({
        current: z.string(),
        available: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .optional(),
  })
  .strict();
export type SessionCreateResult = z.infer<typeof sessionCreateResultSchema>;
/** session.send answers as soon as the round started; its events arrive as session.event notifications. */
export const sessionSendResultSchema = z.object({ started: z.boolean() }).strict();
export const sessionPermissionResultSchema = z.object({ answered: z.boolean() }).strict();
export const sessionCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();

/** Methods whose result is a stream token for a data socket at /api/runner/stream/{token}. */
export const STREAM_TOKEN_METHODS = ["pty.open", "http.open", "mcp.spawn"] as const;
export const streamTokenResultSchema = z
  .object({ stream_token: z.string().min(1), pty_id: z.string().optional() })
  .strict();
/** pty.open's answer: the stream token and the shell's id, for input, resize, close, and reattach. */
export const ptyOpenResultSchema = z
  .object({
    stream_token: z.string().min(1),
    pty_id: z.string().min(1),
    /** Whether an existing shell was reattached (its scrollback is replayed on the stream). */
    reattached: z.boolean(),
  })
  .strict();
export type PtyOpenResult = z.infer<typeof ptyOpenResultSchema>;
/** How long the runner waits for the api to open a stream it announced. */
export const STREAM_OPEN_TIMEOUT_MS = 15_000;

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
