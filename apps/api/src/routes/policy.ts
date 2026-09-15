/**
 * The policy over REST (spec §7.1 `.../policy`, `.../projects/{p}/policy`, `.../policy/evaluate`;
 * task 2.11).
 *
 * A policy is written, not configured: the document goes in and comes back as it was typed, with
 * what it parsed to beside it so a client can show the rules without a YAML parser. The dry run
 * answers the question every rule raises — "would this be allowed?" — without doing the thing.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { parsePolicy } from "@perch/policy";
import { authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { savePolicy } from "../repos/policy.ts";
import { getProject } from "../services/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const workspaceParam = z.object({ ws: z.uuid() });
const projectParam = z.object({ ws: z.uuid(), project: z.string().min(1) });

const policySchema = z
  .object({
    /** The document as it was written. Empty when nothing has been set. */
    yaml: z.string(),
    /** What it parsed to: the same rules, as JSON. */
    rules: z.record(z.string(), z.unknown()),
    /** For a project, its workspace's rules and its own, already merged. */
    effective: z.record(z.string(), z.unknown()),
  })
  .openapi("Policy");

const writeBody = z.object({ yaml: z.string().max(100_000) }).openapi("WritePolicy");

const requestSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("git.push"),
      branch: z.string().min(1),
      force: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("exec"), command: z.string().min(1).max(4_000) }),
    z.object({ kind: z.literal("fs.write"), path: z.string().min(1).max(1_000) }),
    z.object({
      kind: z.literal("model"),
      ref: z.string().min(1).max(200),
      profile: z.string().min(1).max(200).optional(),
      channel: z.string().min(1).max(200).optional(),
      project: z.string().min(1).max(200).optional(),
    }),
    z.object({
      kind: z.literal("budget"),
      of: z.enum(["dailyUsd", "perRunUsd", "perThreadUsd"]),
      usd: z.number().min(0),
    }),
    z.object({
      kind: z.literal("bot.mention"),
      channel: z.string().min(1).max(200).optional(),
      hop: z.number().int().min(1).optional(),
    }),
  ])
  .openapi("PolicyRequest");

const evaluateBody = z
  .object({ request: requestSchema, project_id: z.uuid().optional() })
  .openapi("EvaluatePolicy");

const decisionSchema = z
  .object({
    allow: z.boolean(),
    /** Which rule refused it, when one did. */
    rule: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .openapi("PolicyDecision");

const getRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/policy",
  tags: ["policy"],
  summary: "What may happen in this workspace",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: workspaceParam },
  responses: {
    200: { description: "The policy", content: { "application/json": { schema: policySchema } } },
    ...errorResponses(403, 404),
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/api/workspaces/{ws}/policy",
  tags: ["policy"],
  summary: "Write the workspace's policy",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: workspaceParam,
    body: { content: { "application/json": { schema: writeBody } } },
  },
  responses: {
    200: { description: "The policy", content: { "application/json": { schema: policySchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const getProjectRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/policy",
  tags: ["policy"],
  summary: "What may happen in this project",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: { description: "The policy", content: { "application/json": { schema: policySchema } } },
    ...errorResponses(403, 404),
  },
});

const putProjectRoute = createRoute({
  method: "put",
  path: "/api/workspaces/{ws}/projects/{project}/policy",
  tags: ["policy"],
  summary: "Write the project's policy",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: writeBody } } },
  },
  responses: {
    200: { description: "The policy", content: { "application/json": { schema: policySchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const evaluateRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/policy/evaluate",
  tags: ["policy"],
  summary: "Would this be allowed? (a dry run: nothing happens)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: workspaceParam,
    body: { content: { "application/json": { schema: evaluateBody } } },
  },
  responses: {
    200: { description: "The answer", content: { "application/json": { schema: decisionSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

export function registerPolicy(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const projectOf = async (ws: string, keyOrId: string) => {
    const project = await getProject(deps.db.db, ws, keyOrId);
    if (!project) throw PerchError.notFound("project");
    return project;
  };

  const parsed = (yaml: string) => {
    if (!yaml.trim()) return {};
    try {
      return parsePolicy(yaml) as Record<string, unknown>;
    } catch (error) {
      throw PerchError.validation(
        `this policy will not parse: ${error instanceof Error ? error.message : "invalid"}`,
      );
    }
  };

  app.openapi(getRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "workspace.read", { type: "workspace", id: ws });
    const yaml = await deps.policy.yamlOf(ws);
    const rules = await deps.policy.workspacePolicy(ws);
    return c.json({ yaml, rules: rules as Record<string, unknown>, effective: rules }, 200);
  });

  app.openapi(putRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { yaml } = c.req.valid("json");
    await authorize(c, deps, "workspace.update", { type: "workspace", id: ws });
    const rules = parsed(yaml);
    await savePolicy(deps.db.db, { workspaceId: ws }, { yaml, rules, userId: currentUser(c).id });
    deps.policy.forget(`ws:${ws}`);
    return c.json({ yaml, rules, effective: rules }, 200);
  });

  app.openapi(getProjectRoute, async (c) => {
    const { ws, project: key } = c.req.valid("param");
    await authorize(c, deps, "projects.read", { type: "workspace", id: ws });
    const project = await projectOf(ws, key);
    const own = await deps.policy.yamlOf(ws, project.id);
    const effective = await deps.policy.projectPolicy(project);
    return c.json(
      { yaml: own, rules: parsed(own), effective: effective as Record<string, unknown> },
      200,
    );
  });

  app.openapi(putProjectRoute, async (c) => {
    const { ws, project: key } = c.req.valid("param");
    const { yaml } = c.req.valid("json");
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await projectOf(ws, key);
    const rules = parsed(yaml);
    await savePolicy(
      deps.db.db,
      { workspaceId: ws, projectId: project.id },
      { yaml, rules, userId: currentUser(c).id },
    );
    deps.policy.forget(`project:${project.id}`);
    const effective = await deps.policy.projectPolicy(project);
    return c.json({ yaml, rules, effective: effective as Record<string, unknown> }, 200);
  });

  app.openapi(evaluateRoute, async (c) => {
    const { ws } = c.req.valid("param");
    const { request, project_id } = c.req.valid("json");
    await authorize(c, deps, "workspace.read", { type: "workspace", id: ws });
    const project = project_id ? await projectOf(ws, project_id) : undefined;
    const decision = await deps.policy.evaluate(
      { workspaceId: ws, ...(project ? { project } : {}) },
      request,
    );
    return c.json(
      decision.allow
        ? { allow: true, rule: null, reason: null }
        : { allow: false, rule: decision.rule, reason: decision.reason },
      200,
    );
  });
}
