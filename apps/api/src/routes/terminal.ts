/**
 * The terminal socket for a project (spec §5.1, task 1.7, ADR-0073): GET
 * /api/workspaces/{ws}/projects/{project}/terminal upgrades to a WebSocket that relays one shell:
 * the api asks the project's runner for pty.open (reattaching to `pty_id` when the browser has one),
 * opens the runner's stream for the token, and forwards frames both ways. Browser → api frames:
 * {t:"i", d} input, {t:"r", cols, rows} resize. Api → browser: {t:"open", pty_id, reattached},
 * {t:"o", d} output, {t:"x"} the shell ended, {t:"e", message} a failure.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Project } from "@perch/db";
import { type PtyOpenResult, ptyOpenResultSchema, type RunnerLink } from "@perch/events";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import { authorize } from "../auth/authorize.ts";
import { currentUser, requireUser } from "../auth/middleware.ts";
import type { AppEnv, Deps } from "../context.ts";
import { PerchError } from "../errors.ts";
import { getProject, projectRunnerLink } from "../services/projects.ts";
import { runnerError } from "../services/runners.ts";
import type { WsServer } from "../ws/server.ts";
import { projectDeps } from "./projects.ts";

const querySchema = z.object({
  pty_id: z.string().min(1).max(64).optional(),
  cols: z.coerce.number().int().min(2).max(500).default(80),
  rows: z.coerce.number().int().min(2).max(300).default(24),
});

const clientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("i"), d: z.string() }),
  z.object({
    t: z.literal("r"),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  }),
]);

type Target = {
  project: Project;
  link: RunnerLink;
  userId: string;
  query: z.infer<typeof querySchema>;
};

function send(ws: WSContext<unknown>, frame: Record<string, unknown>): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame));
}

export function registerTerminal(app: OpenAPIHono<AppEnv>, deps: Deps, wsServer: WsServer): void {
  const services = projectDeps(deps);
  // The upgrade factory sees the request only; the resolved target rides beside it.
  const targets = new WeakMap<Request, Target>();

  const upgrade = wsServer.upgradeWebSocket((c: Context<AppEnv>) => {
    const target = targets.get(c.req.raw);
    const log = c.get("log");
    let stream: Awaited<ReturnType<NonNullable<RunnerLink["openStream"]>>> | null = null;
    let opened: PtyOpenResult | null = null;
    let closedByClient = false;
    return {
      onOpen(_evt, ws) {
        if (!target) {
          ws.close(1011, "no terminal target");
          return;
        }
        const { project, link, userId, query } = target;
        (async () => {
          if (!link.openStream) throw new Error("this runner cannot open streams");
          const raw = await link.call("pty.open", {
            workspace_id: project.workspaceId,
            user_id: userId,
            cols: query.cols,
            rows: query.rows,
            cwd: `${project.workspaceId}/${project.id}`,
            user: userId,
            ...(query.pty_id ? { pty_id: query.pty_id } : {}),
          });
          const result = ptyOpenResultSchema.parse(raw);
          const s = await link.openStream(result.stream_token);
          if (closedByClient) {
            s.close();
            return;
          }
          stream = s;
          opened = result;
          send(ws, { t: "open", pty_id: result.pty_id, reattached: result.reattached });
          s.onMessage((data) => send(ws, { t: "o", d: data }));
          s.onClose(() => {
            send(ws, { t: "x" });
            if (ws.readyState === 1) ws.close(1000, "shell ended");
          });
        })().catch((error: unknown) => {
          const perch = runnerError(error);
          log.warn({ err: error, projectId: project.id }, "terminal failed to open");
          send(ws, { t: "e", message: perch.message, code: perch.code });
          if (ws.readyState === 1) ws.close(1011, perch.code);
        });
      },
      onMessage(evt) {
        if (!target || typeof evt.data !== "string") return;
        let frame: z.infer<typeof clientFrame>;
        try {
          frame = clientFrame.parse(JSON.parse(evt.data));
        } catch {
          return;
        }
        if (frame.t === "i") {
          stream?.send(frame.d);
        } else if (opened) {
          void target.link
            .call("pty.resize", {
              workspace_id: target.project.workspaceId,
              user_id: target.userId,
              pty_id: opened.pty_id,
              cols: frame.cols,
              rows: frame.rows,
            })
            .catch(() => {});
        }
      },
      onClose() {
        closedByClient = true;
        // The runner keeps the shell for its grace period; a reload reattaches by pty_id.
        stream?.close();
      },
    };
  });

  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    const ws = c.req.param("ws") ?? "";
    const projectId = c.req.param("project") ?? "";
    if (!z.uuid().safeParse(ws).success || !z.uuid().safeParse(projectId).success) {
      throw PerchError.notFound("project");
    }
    const query = querySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    await authorize(c, deps, "projects.update", { type: "workspace", id: ws });
    const project = await getProject(deps.db.db, ws, projectId);
    if (!project) throw PerchError.notFound("project");
    const user = currentUser(c);
    const link = await projectRunnerLink(services, project, user.id);
    targets.set(c.req.raw, { project, link, userId: user.id, query });
    return upgrade(c, next);
  };

  app.get("/api/workspaces/:ws/projects/:project/terminal", requireUser, handler);
}
