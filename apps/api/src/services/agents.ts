/**
 * Agent presence (spec §5.7 "agent presence: busy/idle, 'working on' cards, agent org view"; task
 * 3.19).
 *
 * What every session and every bot in this workspace is doing right now, as one list, with one way
 * to stop any of it. Two tables underneath — `coding_sessions` and `bot_runs` — because those are
 * where a running agent already records itself; there is no third place keeping a register, which
 * would only be a register that can disagree with them.
 */
import type { Bus } from "@perch/bus";
import type { Db, DbHandle } from "@perch/db";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { getBot, runningRuns } from "../repos/bots.ts";
import { findProject } from "../repos/projects.ts";
import { getSession, workingSessions } from "../repos/sessions.ts";
import { findWorkspaceById } from "../repos/workspaces.ts";
import type { BotsService } from "./bots.ts";
import type { SessionService } from "./sessions.ts";

export type AgentKind = "session" | "bot";

/** One row: what it is, what it is doing, and where to go and look. */
export type AgentRow = {
  kind: AgentKind;
  id: string;
  title: string;
  state: string;
  engine: string | null;
  project: { id: string; key: string; name: string } | null;
  bot: { id: string; name: string; handle: string } | null;
  startedAt: Date;
  turns: number | null;
  costUsd: number;
  url: string;
};

export type AgentsDeps = {
  db: DbHandle;
  bus: Bus;
  log: Logger;
  sessions: Pick<SessionService, "cancel">;
  bots: Pick<BotsService, "stop">;
};

export class AgentsService {
  constructor(private readonly deps: AgentsDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  /**
   * Everything working, oldest first: the one that has been going longest is the one worth
   * looking at. An inline lane (⌘K) is not an agent anybody watches, so it is not here.
   */
  async list(workspaceId: string): Promise<AgentRow[]> {
    const workspace = await findWorkspaceById(this.db, workspaceId);
    const slug = workspace?.slug ?? workspaceId;
    const rows: AgentRow[] = [];

    for (const session of await workingSessions(this.db, workspaceId)) {
      const project = await findProject(this.db, workspaceId, session.projectId);
      rows.push({
        kind: "session",
        id: session.id,
        title: session.title ?? "a session",
        state: session.status,
        engine: session.engine,
        project: project ? { id: project.id, key: project.key, name: project.name } : null,
        bot: null,
        startedAt: session.startedAt,
        turns: session.turns,
        costUsd: session.costUsd,
        url: project
          ? `/${slug}/code/${project.key}?session=${session.id}`
          : `/${slug}/code?session=${session.id}`,
      });
    }

    for (const run of await runningRuns(this.db, workspaceId)) {
      const bot = await getBot(this.db, run.botId);
      rows.push({
        kind: "bot",
        id: run.id,
        title: bot ? `${bot.name} (${run.trigger})` : run.trigger,
        state: run.status,
        engine: run.engine,
        project: null,
        bot: bot ? { id: bot.id, name: bot.name, handle: bot.handle } : null,
        startedAt: run.startedAt,
        turns: null,
        costUsd: Number(run.costUsd),
        url: `/${slug}/bots/${run.botId}`,
      });
    }

    return rows.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  /**
   * The kill switch. One endpoint for both kinds, because the row a person is looking at has one
   * button on it and should not have to know what sort of thing it is stopping.
   */
  async stop(
    workspaceId: string,
    kind: AgentKind,
    id: string,
    by: ActorContext,
  ): Promise<{ stopped: boolean }> {
    if (kind === "session") {
      const session = await getSession(this.db, id);
      if (!session || session.workspaceId !== workspaceId) throw PerchError.notFound("session");
      const { cancelled } = await this.deps.sessions.cancel(session);
      await this.told(workspaceId, kind, id, cancelled, by);
      return { stopped: cancelled };
    }
    const run = (await runningRuns(this.db, workspaceId)).find((one) => one.id === id);
    if (!run) throw PerchError.notFound("bot run");
    const stopped = this.deps.bots.stop(id);
    await this.told(workspaceId, kind, id, stopped, by);
    return { stopped };
  }

  /** Stopping an agent is a thing somebody did, so the audit log hears about it (spec §9.1). */
  private async told(
    workspaceId: string,
    kind: AgentKind,
    id: string,
    stopped: boolean,
    by: ActorContext,
  ): Promise<void> {
    await this.deps.bus.publish("agent.stopped", { workspaceId, kind, agentId: id, stopped }, by);
  }
}
