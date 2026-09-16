/**
 * Usage and budgets over REST (spec §7.1 `.../usage?from&to&group_by`; task 4.2).
 *
 * The ledger is the workspace's own accounting, so reading it is a member's right and setting a
 * ceiling on it is an admin's.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { BUDGET_PERIODS, BUDGET_SUBJECTS, type Budget } from "@perch/db";
import { authorize } from "../auth/authorize.ts";
import { requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { USAGE_GROUPS } from "../repos/virtual-keys.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const wsParam = z.object({ ws: z.uuid() });

const sliceSchema = z
  .object({
    /** The model, the provider, the actor, the day, or the key — whichever was asked for. */
    key: z.string(),
    calls: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cost_usd: z.number(),
  })
  .openapi("UsageSlice");

const budgetSchema = z
  .object({
    id: z.uuid(),
    subject_type: z.enum(BUDGET_SUBJECTS),
    subject_id: z.uuid().nullable(),
    limit_usd: z.number(),
    period: z.enum(BUDGET_PERIODS),
    /** The fraction of the limit worth a word before it is reached; 0 means no warning. */
    warn_at: z.number(),
    /** What has been spent inside this budget's window, and what is left of it. */
    spent_usd: z.number(),
    remaining_usd: z.number(),
    created_at: z.string(),
  })
  .openapi("Budget");

const setBody = z
  .object({
    subject_type: z.enum(BUDGET_SUBJECTS),
    subject_id: z.uuid().optional(),
    limit_usd: z.number().min(0).max(1_000_000),
    period: z.enum(BUDGET_PERIODS).default("month"),
    warn_at: z.number().min(0).max(1).optional(),
  })
  .openapi("SetBudget");

const usageRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/usage",
  tags: ["brains"],
  summary: "What this workspace has spent, added up the way you ask for",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: wsParam,
    query: z.object({
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      group_by: z.enum(USAGE_GROUPS).default("model"),
    }),
  },
  responses: {
    200: {
      description: "The slices, most expensive first",
      content: {
        "application/json": {
          schema: z
            .object({
              group_by: z.enum(USAGE_GROUPS),
              total_usd: z.number(),
              slices: z.array(sliceSchema),
            })
            .openapi("Usage"),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

const listBudgetsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/budgets",
  tags: ["brains"],
  summary: "The ceilings this workspace has set, and where each one stands",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam },
  responses: {
    200: {
      description: "Budgets",
      content: { "application/json": { schema: z.object({ budgets: z.array(budgetSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const setBudgetRoute = createRoute({
  method: "put",
  path: "/api/workspaces/{ws}/budgets",
  tags: ["brains"],
  summary: "Set a budget for the workspace, a person, or a bot",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam, body: { content: { "application/json": { schema: setBody } } } },
  responses: {
    200: { description: "The budget", content: { "application/json": { schema: budgetSchema } } },
    ...errorResponses(403, 404, 422),
  },
});

const deleteBudgetRoute = createRoute({
  method: "delete",
  path: "/api/workspaces/{ws}/budgets/{id}",
  tags: ["brains"],
  summary: "Take a budget away; the ledger keeps what was spent",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: wsParam.extend({ id: z.uuid() }) },
  responses: { 204: { description: "Gone" }, ...errorResponses(403, 404) },
});

export function registerUsage(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const view = async (ws: string, row: Budget) => {
    const standing = await deps.budgets.standing(ws, {
      type: row.subjectType,
      id: row.subjectId,
    });
    return {
      id: row.id,
      subject_type: row.subjectType,
      subject_id: row.subjectId,
      limit_usd: Number(row.limitUsd),
      period: row.period,
      warn_at: Number(row.warnAt),
      spent_usd: Math.round(standing.spentUsd * 1e6) / 1e6,
      remaining_usd: standing.remainingUsd ?? 0,
      created_at: row.createdAt.toISOString(),
    };
  };

  app.openapi(usageRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.read", { type: "workspace", id: ws });
    const query = c.req.valid("query");
    const slices = await deps.budgets.usage(ws, {
      group: query.group_by,
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    });
    const total = slices.reduce((sum, slice) => sum + slice.costUsd, 0);
    return c.json(
      {
        group_by: query.group_by,
        total_usd: Math.round(total * 1e6) / 1e6,
        slices: slices.map((slice) => ({
          key: slice.key,
          calls: slice.calls,
          input_tokens: slice.inputTokens,
          output_tokens: slice.outputTokens,
          cost_usd: Math.round(slice.costUsd * 1e6) / 1e6,
        })),
      },
      200,
    );
  });

  app.openapi(listBudgetsRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.read", { type: "workspace", id: ws });
    const rows = await deps.budgets.list(ws);
    return c.json({ budgets: await Promise.all(rows.map((row) => view(ws, row))) }, 200);
  });

  app.openapi(setBudgetRoute, async (c) => {
    const { ws } = c.req.valid("param");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    const body = c.req.valid("json");
    const row = await deps.budgets.set({
      workspaceId: ws,
      subjectType: body.subject_type,
      ...(body.subject_id ? { subjectId: body.subject_id } : {}),
      limitUsd: body.limit_usd,
      period: body.period,
      ...(body.warn_at === undefined ? {} : { warnAt: body.warn_at }),
    });
    return c.json(await view(ws, row), 200);
  });

  app.openapi(deleteBudgetRoute, async (c) => {
    const { ws, id } = c.req.valid("param");
    await authorize(c, deps, "brains.admin", { type: "workspace", id: ws });
    await deps.budgets.remove(ws, id);
    return c.body(null, 204);
  });
}
