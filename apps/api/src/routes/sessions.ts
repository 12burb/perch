/**
 * Sessions over REST (spec §7.1: POST .../projects/{p}/sessions, /api/sessions/{s} with turns,
 * permissions/{id}, cancel, events?after_seq; task 1.8, ADR-0074). Live updates travel on the WS
 * topic session:<id>; the events route replays the transcript from a seq.
 */
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { CodingSession } from "@perch/db";
import {
  permissionAnswerSchema,
  sessionEventSchema,
  sessionModeSchema,
  sessionStatusSchema,
  userTurnSchema,
} from "@perch/events";
import { actorOf, authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getProject } from "../services/projects.ts";
import { errorResponses, SESSION_OR_BEARER } from "./shared.ts";

const projectParam = z.object({ ws: z.uuid(), project: z.uuid() });
const sessionParam = z.object({ s: z.uuid() });

const modelBody = z
  .object({
    provider: z.string().min(1).max(64),
    model_id: z.string().min(1).max(200),
    profile_id: z.uuid().optional(),
  })
  .openapi("ModelRef");

export const sessionSchema = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    project_id: z.uuid(),
    runner_id: z.uuid().nullable(),
    user_id: z.uuid(),
    engine: z.string(),
    engine_session_id: z.string().nullable(),
    model: modelBody,
    mode: sessionModeSchema,
    status: sessionStatusSchema,
    status_message: z.string().nullable(),
    title: z.string().nullable(),
    cost_usd: z.number(),
    turns: z.number().int(),
    last_seq: z.number().int(),
    started_at: z.string(),
    ended_at: z.string().nullable(),
  })
  .openapi("Session");

export function sessionBody(row: CodingSession): z.infer<typeof sessionSchema> {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    project_id: row.projectId,
    runner_id: row.runnerId,
    user_id: row.userId,
    engine: row.engine,
    engine_session_id: row.engineSessionId,
    model: {
      provider: row.modelProvider,
      model_id: row.modelId,
      ...(row.modelProfileId ? { profile_id: row.modelProfileId } : {}),
    },
    mode: row.mode,
    status: row.status,
    status_message: row.statusMessage,
    title: row.title,
    cost_usd: row.costUsd,
    turns: row.turns,
    last_seq: row.lastSeq,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

const createBody = z
  .object({
    engine: z.string().min(1).max(64).optional(),
    model: modelBody.optional(),
    mode: sessionModeSchema.optional(),
    title: z.string().min(1).max(200).optional(),
    /** Sends the first turn right away. */
    prompt: z.string().min(1).max(100_000).optional(),
  })
  .openapi("CreateSession");

const turnBody = z
  .object({
    text: z.string().min(1).max(100_000),
    attachments: z.array(z.string()).max(32).optional(),
    mode: sessionModeSchema.optional(),
  })
  .openapi("SessionTurn");

const eventRecordSchema = z
  .object({ seq: z.number().int(), ts: z.string(), event: sessionEventSchema })
  .openapi("SessionEventRecord");

const sessionErrors = errorResponses(403, 404, 409, 422, 502);

const createSessionRoute = createRoute({
  method: "post",
  path: "/api/workspaces/{ws}/projects/{project}/sessions",
  tags: ["sessions"],
  summary: "Open an agent session in a project (optionally sending the first turn)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: projectParam,
    body: { content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: { description: "The session", content: { "application/json": { schema: sessionSchema } } },
    ...sessionErrors,
  },
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/api/workspaces/{ws}/projects/{project}/sessions",
  tags: ["sessions"],
  summary: "The project's sessions, newest first",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: projectParam },
  responses: {
    200: {
      description: "Sessions",
      content: { "application/json": { schema: z.object({ sessions: z.array(sessionSchema) }) } },
    },
    ...errorResponses(403, 404),
  },
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/api/sessions/{s}",
  tags: ["sessions"],
  summary: "A session",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: sessionParam },
  responses: {
    200: { description: "The session", content: { "application/json": { schema: sessionSchema } } },
    ...errorResponses(403, 404),
  },
});

const sendTurnRoute = createRoute({
  method: "post",
  path: "/api/sessions/{s}/turns",
  tags: ["sessions"],
  summary: "Send a turn; the engine answers on the session's WS topic and in the events replay",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: sessionParam,
    body: { content: { "application/json": { schema: turnBody } } },
  },
  responses: {
    202: {
      description: "The turn's seq and the session",
      content: {
        "application/json": {
          schema: z.object({ seq: z.number().int(), session: sessionSchema }),
        },
      },
    },
    ...sessionErrors,
  },
});

const permissionRoute = createRoute({
  method: "post",
  path: "/api/sessions/{s}/permissions/{id}",
  tags: ["sessions"],
  summary: "Answer a permission request (allow once, always this session, deny)",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: z.object({ s: z.uuid(), id: z.string().min(1).max(200) }),
    body: {
      content: { "application/json": { schema: z.object({ answer: permissionAnswerSchema }) } },
    },
  },
  responses: {
    200: { description: "The session", content: { "application/json": { schema: sessionSchema } } },
    ...sessionErrors,
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/api/sessions/{s}/cancel",
  tags: ["sessions"],
  summary: "Cancel the running round",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: { params: sessionParam },
  responses: {
    200: {
      description: "Whether a round was running",
      content: { "application/json": { schema: z.object({ cancelled: z.boolean() }) } },
    },
    ...sessionErrors,
  },
});

const eventsRoute = createRoute({
  method: "get",
  path: "/api/sessions/{s}/events",
  tags: ["sessions"],
  summary: "Replay the transcript after a seq",
  middleware: [requireUser] as const,
  security: SESSION_OR_BEARER,
  request: {
    params: sessionParam,
    query: z.object({
      after_seq: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }),
  },
  responses: {
    200: {
      description: "Events after the seq, in order, and the session's latest seq",
      content: {
        "application/json": {
          schema: z.object({ events: z.array(eventRecordSchema), last_seq: z.number().int() }),
        },
      },
    },
    ...errorResponses(403, 404),
  },
});

export function registerSessions(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const sessions = deps.sessions;

  /** Loads a session and authorizes the action in its workspace (strangers see nothing). */
  async function load(
    c: Parameters<typeof authorize>[0],
    id: string,
    action: "sessions.read" | "sessions.update",
  ): Promise<CodingSession> {
    const session = await sessions.get(id);
    if (!session) throw PerchError.notFound("session");
    await authorize(c, deps, action, { type: "workspace", id: session.workspaceId });
    return session;
  }

  app.openapi(createSessionRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    await authorize(c, deps, "sessions.create", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const user = currentUser(c);
    const by = actorOf(c);
    let session = await sessions.create({
      project,
      userId: user.id,
      ...(body.engine ? { engine: body.engine } : {}),
      ...(body.model
        ? {
            model: {
              provider: body.model.provider,
              modelId: body.model.model_id,
              ...(body.model.profile_id ? { profileId: body.model.profile_id } : {}),
            },
          }
        : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      title: body.title ?? null,
      by,
    });
    if (body.prompt) {
      try {
        const sent = await sessions.sendTurn(session, user.id, { text: body.prompt }, { by });
        session = sent.session;
      } catch (error) {
        // The session exists; a first turn that could not start is on it as an error.
        if (!(error instanceof PerchError)) throw error;
        session = (await sessions.get(session.id)) ?? session;
      }
    }
    return c.json(sessionBody(session), 201);
  });

  app.openapi(listSessionsRoute, async (c) => {
    const { ws, project: projectId } = c.req.valid("param");
    await authorize(c, deps, "sessions.read", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const rows = await sessions.list(ws, projectId);
    return c.json({ sessions: rows.map(sessionBody) }, 200);
  });

  app.openapi(getSessionRoute, async (c) => {
    const { s } = c.req.valid("param");
    const session = await load(c, s, "sessions.read");
    return c.json(sessionBody(session), 200);
  });

  app.openapi(sendTurnRoute, async (c) => {
    const { s } = c.req.valid("param");
    const body = c.req.valid("json");
    const session = await load(c, s, "sessions.update");
    const user = currentUser(c);
    const turn = userTurnSchema.parse({
      text: body.text,
      ...(body.attachments ? { attachments: body.attachments } : {}),
    });
    const sent = await sessions.sendTurn(session, user.id, turn, {
      ...(body.mode ? { mode: body.mode } : {}),
      by: actorOf(c),
    });
    return c.json({ seq: sent.seq, session: sessionBody(sent.session) }, 202);
  });

  app.openapi(permissionRoute, async (c) => {
    const { s, id } = c.req.valid("param");
    const { answer } = c.req.valid("json");
    const session = await load(c, s, "sessions.update");
    const user = currentUser(c);
    const updated = await sessions.respondPermission(session, id, answer, user.id, actorOf(c));
    return c.json(sessionBody(updated), 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const { s } = c.req.valid("param");
    const session = await load(c, s, "sessions.update");
    const result = await sessions.cancel(session);
    return c.json(result, 200);
  });

  app.openapi(eventsRoute, async (c) => {
    const { s } = c.req.valid("param");
    const { after_seq, limit } = c.req.valid("query");
    const session = await load(c, s, "sessions.read");
    const events = await sessions.events(session.id, after_seq, limit);
    const latest = await sessions.get(session.id);
    return c.json(
      {
        events: events.map((e) => ({ seq: e.seq, ts: e.ts.toISOString(), event: e.event })),
        last_seq: latest?.lastSeq ?? session.lastSeq,
      },
      200,
    );
  });
}
