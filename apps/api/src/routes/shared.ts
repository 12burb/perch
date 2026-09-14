import { z } from "@hono/zod-openapi";
import { PERCH_ERROR_CODES } from "@perch/events";

/** The §7.8 error body, registered once as a component. */
export const errorBodySchema = z
  .object({
    error: z.object({
      code: z.enum(PERCH_ERROR_CODES as [string, ...string[]]),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
    request_id: z.string(),
  })
  .openapi("Error");

const DESCRIPTIONS: Record<number, string> = {
  402: "Budget exceeded",
  403: "Forbidden (including unauthenticated)",
  404: "Not found",
  409: "Conflict",
  422: "Validation failed",
  429: "Rate limited",
  451: "Policy violation",
  502: "Upstream failed",
  500: "Internal error",
};

/** Error responses for a route, keyed by status. */
export function errorResponses(...statuses: number[]) {
  const out: Record<
    number,
    { description: string; content: { "application/json": { schema: typeof errorBodySchema } } }
  > = {};
  for (const status of statuses) {
    out[status] = {
      description: DESCRIPTIONS[status] ?? "Error",
      content: { "application/json": { schema: errorBodySchema } },
    };
  }
  return out;
}

export const workspaceSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    plan: z.string(),
    created_at: z.string(),
  })
  .openapi("Workspace");

export function workspaceBody(ws: {
  id: string;
  slug: string;
  name: string;
  plan: string;
  createdAt: Date;
}) {
  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    plan: ws.plan,
    created_at: ws.createdAt.toISOString(),
  };
}

/**
 * Either a session cookie or a bearer api token. Declared with an explicit type: an inline
 * two-entry array infers a union element type that collapses `c.req.valid()` to `never`.
 */
export const SESSION_OR_BEARER: Array<Record<string, string[]>> = [{ session: [] }, { bearer: [] }];
export const SESSION_ONLY: Array<Record<string, string[]>> = [{ session: [] }];

export const membershipRoleSchema = z.enum(["owner", "admin", "member"]).openapi("MembershipRole");
