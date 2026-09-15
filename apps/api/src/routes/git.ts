/**
 * Git over REST (spec §5.1 "git panel: status, stage, AI commit message, branch, push, Open PR";
 * task 1.20).
 *
 * Every call is one runner method with the member's identity attached: git runs where the project
 * is, not where the api is. A push takes a connection, and the token is minted for that one push
 * and never written down (AGENTS.md §1.6) — the same credential path a clone and a pull request
 * take.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  gitBranchResultSchema,
  gitCommitResultSchema,
  gitDiffResultSchema,
  gitPushResultSchema,
  gitStatusResultSchema,
} from "@perch/events";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getProject, projectRunnerLink } from "../services/projects.ts";
import { runnerCall } from "../services/runners.ts";
import { projectDeps } from "./projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });

/** git's empty tree: what a repository with no commits is compared against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const statusSchema = z
  .object({
    branch: z.string().nullable(),
    tracking: z.string().nullable(),
    ahead: z.number().int(),
    behind: z.number().int(),
    clean: z.boolean(),
    files: z.array(z.object({ path: z.string(), index: z.string(), working_tree: z.string() })),
  })
  .openapi("GitStatus");

const diffSchema = z
  .object({
    diff: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
        binary: z.boolean(),
      }),
    ),
  })
  .openapi("GitDiff");

const commitSchema = z
  .object({
    commit: z.string(),
    branch: z.string(),
    summary: z.object({
      changes: z.number().int(),
      insertions: z.number().int(),
      deletions: z.number().int(),
    }),
  })
  .openapi("GitCommit");

const pushSchema = z
  .object({ pushed: z.boolean(), remote: z.string(), branch: z.string() })
  .openapi("GitPush");

const branchSchema = z
  .object({
    current: z.string().nullable(),
    branches: z.array(z.string()),
    created: z.boolean().optional(),
  })
  .openapi("GitBranches");

const messageSchema = z
  .object({ message: z.string(), session_id: z.uuid() })
  .openapi("GitCommitMessage");

const statusRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/git/status",
  tags: ["git"],
  summary: "The working tree: branch, tracking, and what changed",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: { description: "Status", content: { "application/json": { schema: statusSchema } } },
    ...errorResponses(403, 404, 409, 451, 502),
  },
});

const diffRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/git/diff",
  tags: ["git"],
  summary: "The working tree's diff, or one ref against another",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    query: z.object({
      ref: z.string().max(200).optional(),
      to: z.string().max(200).optional(),
    }),
  },
  responses: {
    200: { description: "Diff", content: { "application/json": { schema: diffSchema } } },
    ...errorResponses(403, 404, 409, 451, 502),
  },
});

const commitRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/git/commit",
  tags: ["git"],
  summary: "Commit the named paths, or everything that changed",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              message: z.string().min(1).max(20_000),
              /** What to commit; everything that changed when it is not said (spec §5.1 "stage"). */
              paths: z.array(z.string().min(1).max(1024)).max(1000).optional(),
            })
            .openapi("GitCommitRequest"),
        },
      },
    },
  },
  responses: {
    201: { description: "The commit", content: { "application/json": { schema: commitSchema } } },
    ...errorResponses(403, 404, 409, 451, 502),
  },
});

const pushRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/git/push",
  tags: ["git"],
  summary: "Push the branch, on a connection's token or the workspace's deploy key",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              branch: z.string().min(1).max(200).optional(),
              connection_id: z.uuid().optional(),
            })
            .openapi("GitPushRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "Pushed", content: { "application/json": { schema: pushSchema } } },
    ...errorResponses(403, 404, 409, 451, 502),
  },
});

const branchesRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/git/branches",
  tags: ["git"],
  summary: "The branches this project has, and which one it is on",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: { description: "Branches", content: { "application/json": { schema: branchSchema } } },
    ...errorResponses(403, 404, 409, 451, 502),
  },
});

const switchRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/git/branches",
  tags: ["git"],
  summary: "Switch to a branch, creating it when asked",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ name: z.string().min(1).max(200), create: z.boolean().default(false) })
            .openapi("GitBranchRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "Branches", content: { "application/json": { schema: branchSchema } } },
    ...errorResponses(403, 404, 409, 422, 451, 502),
  },
});

const messageRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/git/message",
  tags: ["git"],
  summary: "Draft a commit message from what changed",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              paths: z.array(z.string().min(1).max(1024)).max(1000).optional(),
            })
            .openapi("GitMessageRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "A draft", content: { "application/json": { schema: messageSchema } } },
    ...errorResponses(403, 404, 409, 451, 502),
  },
});

export function registerGit(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const services = projectDeps(deps);

  /** The project and the link to its runner, or the reason there is neither. */
  async function target(c: { req: { valid: (k: "param") => { ws: string; project: string } } }) {
    const { ws, project: projectId } = c.req.valid("param");
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    return project;
  }

  app.openapi(statusRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await target(c);
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    const raw = await runnerCall(link, "git.status", {
      workspace_id: ws,
      user_id: user.id,
      project: project.id,
    });
    const status = gitStatusResultSchema.parse(raw);
    return c.json(
      {
        branch: status.branch,
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
        clean: status.clean,
        files: status.files.map((file) => ({
          path: file.path,
          index: file.index,
          working_tree: file.workingTree,
        })),
      },
      200,
    );
  });

  app.openapi(diffRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const query = c.req.valid("query");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await target(c);
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    const raw = await runnerCall(link, "git.diff", {
      workspace_id: ws,
      user_id: user.id,
      project: project.id,
      ...(query.ref ? { ref: query.ref } : {}),
      ...(query.to ? { to: query.to } : {}),
    });
    return c.json(gitDiffResultSchema.parse(raw), 200);
  });

  app.openapi(commitRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await target(c);
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    const raw = await runnerCall(link, "git.commit", {
      workspace_id: ws,
      user_id: user.id,
      project: project.id,
      message: body.message,
      ...(body.paths?.length ? { paths: body.paths } : {}),
      // Who committed is the member, not the runner's git config (ADR-0070).
      author: { name: user.name, email: user.email },
    });
    return c.json(gitCommitResultSchema.parse(raw), 201);
  });

  app.openapi(pushRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await target(c);
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    const auth = await pushCredential(deps, project.workspaceId, user.id, body.connection_id);
    const raw = await runnerCall(link, "git.push", {
      workspace_id: ws,
      user_id: user.id,
      project: project.id,
      ...(body.branch ? { branch: body.branch } : {}),
      ...(auth ? { auth } : {}),
    });
    const pushed = gitPushResultSchema.parse(raw);
    return c.json({ pushed: true, remote: pushed.remote, branch: pushed.branch }, 200);
  });

  app.openapi(branchesRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await target(c);
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    const raw = await runnerCall(link, "git.branch", {
      workspace_id: ws,
      user_id: user.id,
      project: project.id,
    });
    return c.json(gitBranchResultSchema.parse(raw), 200);
  });

  app.openapi(switchRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await target(c);
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    const raw = await runnerCall(link, "git.branch", {
      workspace_id: ws,
      user_id: user.id,
      project: project.id,
      name: body.name,
      ...(body.create ? { create: true } : {}),
    });
    return c.json(gitBranchResultSchema.parse(raw), 200);
  });

  app.openapi(messageRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "sessions.create", { type: "workspace", id: ws });
    const project = await target(c);
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    // Against a ref rather than the index, so a file that is new — the usual case for the first
    // commit of a feature — is in the diff the message is written from. A repository with no
    // commits yet has no HEAD, and git's empty tree is what it is compared against instead.
    const raw = await runnerCall(link, "git.diff", {
      workspace_id: ws,
      user_id: user.id,
      project: project.id,
      ref: "HEAD",
    }).catch(() =>
      runnerCall(link, "git.diff", {
        workspace_id: ws,
        user_id: user.id,
        project: project.id,
        ref: EMPTY_TREE,
      }),
    );
    const { diff, files } = gitDiffResultSchema.parse(raw);
    const wanted = body.paths?.length ? new Set(body.paths) : null;
    const scoped = wanted ? onlyPaths(diff, files, wanted) : diff;
    if (!scoped.trim()) throw PerchError.conflict("there is nothing to describe");
    const drafted = await deps.sessions.commitMessage({
      project,
      userId: user.id,
      diff: scoped,
      by: actorOf(c),
    });
    return c.json({ message: drafted.message, session_id: drafted.sessionId }, 200);
  });
}

/**
 * The diff of some of its files. A unified diff's files start at `diff --git`, so keeping a subset
 * is a matter of keeping those blocks — no re-running git for a subset of what it already said.
 */
export function onlyPaths(diff: string, files: { path: string }[], wanted: Set<string>): string {
  if (files.every((file) => wanted.has(file.path))) return diff;
  const blocks = diff.split(/^(?=diff --git )/m).filter(Boolean);
  return blocks
    .filter((block) => {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
      const a = header?.[1];
      const b = header?.[2];
      return (a && wanted.has(a)) || (b && wanted.has(b));
    })
    .join("");
}

/** What a push authenticates with: a connection the member may use, or the workspace's key. */
async function pushCredential(
  deps: Deps,
  workspaceId: string,
  userId: string,
  connectionId: string | undefined,
): Promise<{ kind: "token"; token: string; username?: string } | null> {
  if (!connectionId) return null;
  const connection = await deps.connections.connectionFor(workspaceId, userId, connectionId);
  if (!connection) throw PerchError.notFound("connection");
  const token = await deps.connections.tokenFor(connection);
  return { kind: "token", token, username: "x-access-token" };
}
