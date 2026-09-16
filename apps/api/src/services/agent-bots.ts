/**
 * Agent bots (spec §5.3 "Agent bots: `engine: opencode|acp` + `projects: [...]` — `@dawn add a
 * dark-mode toggle` opens a session on that project, posts a session_card in the thread, asks
 * permissions in-thread, and finishes with a diff_card, Open in IDE, and a PR link"; task 3.7).
 *
 * This is the seam between a chat and a coding session, and it goes one way in each direction. The
 * bots service asks it to open one; everything after that arrives on the bus — a permission the
 * engine wants, the turn finishing, the turn failing — and is posted back into the thread the
 * session was opened from. Nothing polls, and the session does not know it is being watched: it
 * carries a channel and a bot on its row, and this subscribes (spec §9.1).
 */

import type { BotEvents, InteractionReceived } from "@perch/bots";
import type { Bus, Unsubscribe } from "@perch/bus";
import type { Bot, Channel, CodingSession, Db, MessageBlock, Project } from "@perch/db";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { getBot } from "../repos/bots.ts";
import { getChannel } from "../repos/channels.ts";
import { listConnections } from "../repos/connections.ts";
import { insertMessage } from "../repos/messages.ts";
import { listProjects } from "../repos/projects.ts";
import { getSession } from "../repos/sessions.ts";
import { findWorkspaceById } from "../repos/workspaces.ts";
import type { RunnerRegistry } from "../runners/registry.ts";
import type { ConnectionsService } from "./connections.ts";
import type { PolicyService } from "./policy.ts";
import { projectRunnerLink } from "./projects.ts";
import type { SessionService } from "./sessions.ts";
import { branchName, ship } from "./ship.ts";

/** What the permission card in a thread asks, so the answer finds its way back to the engine. */
export const SESSION_PERMISSION_ACTION = "session.permission";

export type AgentBotsDeps = {
  db: Db;
  bus: Bus;
  botEvents: BotEvents;
  sessions: Pick<SessionService, "create" | "sendTurn" | "respondPermission" | "get">;
  connections: ConnectionsService;
  policy: PolicyService;
  log: Logger;
  /** The runner a project is on, and the reader the secret scan uses (task 2.12). */
  runners: { db: Db; registry: RunnerRegistry };
};

/** A session opened from a chat, with everything the thread needs to hear about it again. */
type InThread = { session: CodingSession; bot: Bot; channel: Channel };

export class AgentBotsService {
  constructor(private readonly deps: AgentBotsDeps) {}

  /**
   * The project a mention meant: one it names, else the bot's first. A bot with no projects has
   * nothing to work on, which is a thing to say rather than a thing to guess.
   */
  private async projectFor(
    workspaceId: string,
    wanted: readonly string[],
    said: string,
  ): Promise<Project> {
    const all = await listProjects(this.deps.db, workspaceId);
    const mine = wanted.length === 0 ? all : all.filter((row) => matches(row, wanted));
    if (mine.length === 0) throw PerchError.validation("this bot has no project to work on");
    const lowered = said.toLowerCase();
    // "on perch-web" or just the name anywhere in the ask: the one somebody named wins.
    const named = mine.find((row) => lowered.includes(row.name.toLowerCase()));
    const chosen = named ?? mine[0];
    if (!chosen) throw PerchError.validation("this bot has no project to work on");
    return chosen;
  }

  /** Opens the session the mention asked for, in the thread it was asked in. */
  async open(input: {
    bot: Bot;
    channel: Channel;
    threadRootId: string | null;
    projects: readonly string[];
    engine: string;
    prompt: string;
  }): Promise<{ sessionId: string; project: string; status: string; url: string }> {
    const project = await this.projectFor(input.channel.workspaceId, input.projects, input.prompt);
    // A bot has no runner of its own: the session is its owner's, and the actor says which bot
    // asked for it, so the audit log records both (the same rule as the Bot API's sessions.open).
    const by: ActorContext = { actor: { type: "bot", id: input.bot.id }, meta: {} };
    const session = await this.deps.sessions.create({
      project,
      userId: input.bot.ownerId,
      ...(input.engine ? { engine: input.engine } : {}),
      title: input.prompt.slice(0, 120) || `${input.bot.name} at work`,
      channelId: input.channel.id,
      threadRootId: input.threadRootId,
      botId: input.bot.id,
      by,
    });
    // The turn runs in the background; what a person sees now is the card.
    void this.deps.sessions
      .sendTurn(session, input.bot.ownerId, { text: input.prompt || "have a look" }, { by })
      .catch((error: unknown) => {
        this.deps.log.warn(
          { err: error, sessionId: session.id },
          "an agent bot's first turn did not start",
        );
      });
    return {
      sessionId: session.id,
      project: project.name,
      status: session.status,
      url: await this.sessionUrl(project, session.id),
    };
  }

  /** Where a person opens it: the project in Code mode with this session in the panel (§4). */
  private async sessionUrl(project: Project, sessionId: string): Promise<string> {
    const workspace = await findWorkspaceById(this.deps.db, project.workspaceId);
    return `/${workspace?.slug ?? project.workspaceId}/code/${project.key}?session=${sessionId}`;
  }

  /** The session, its bot and its channel — or nothing, when it was not opened from a chat. */
  private async inThread(sessionId: string): Promise<InThread | null> {
    const session = await getSession(this.deps.db, sessionId);
    if (!session?.botId || !session.channelId) return null;
    const bot = await getBot(this.deps.db, session.botId);
    const channel = await getChannel(this.deps.db, session.channelId);
    return bot && channel ? { session, bot, channel } : null;
  }

  /** Whatever the bot has to say about its session, in the thread it was asked in. */
  private async post(where: InThread, blocks: MessageBlock[]): Promise<void> {
    const message = await insertMessage(this.deps.db, {
      workspaceId: where.channel.workspaceId,
      channelId: where.channel.id,
      threadRootId: where.session.threadRootId,
      authorType: "bot",
      authorId: where.bot.id,
      blocks,
    });
    await this.deps.bus.publish(
      "message.created",
      {
        workspaceId: where.channel.workspaceId,
        channelId: where.channel.id,
        messageId: message.id,
        ...(where.session.threadRootId ? { threadRootId: where.session.threadRootId } : {}),
        authorType: "bot" as const,
        authorId: where.bot.id,
      },
      { actor: { type: "bot", id: where.bot.id }, meta: {} },
    );
  }

  /**
   * The engine wants to do something it has to ask about (spec §5.3 "asks permissions in-thread").
   * The card is the same approve_deny everything else uses; answering it answers the engine.
   */
  private async askedPermission(payload: {
    sessionId: string;
    permissionId: string;
    tool: string;
  }): Promise<void> {
    const where = await this.inThread(payload.sessionId);
    if (!where) return;
    await this.post(where, [
      {
        type: "approve_deny",
        id: `${SESSION_PERMISSION_ACTION}:${payload.sessionId}:${payload.permissionId}`,
        action: SESSION_PERMISSION_ACTION,
        text: `${where.bot.name} wants to ${payload.tool}`,
      },
    ]);
  }

  /** Somebody pressed Approve or Deny on one of those cards. */
  private async answered(payload: InteractionReceived): Promise<void> {
    const rest = payload.block_id.startsWith(`${SESSION_PERMISSION_ACTION}:`)
      ? payload.block_id.slice(SESSION_PERMISSION_ACTION.length + 1)
      : "";
    const at = rest.indexOf(":");
    const sessionId = at < 0 ? "" : rest.slice(0, at);
    const permissionId = at < 0 ? "" : rest.slice(at + 1);
    if (!sessionId || !permissionId || payload.user.type !== "user") return;
    const session = await getSession(this.deps.db, sessionId);
    if (!session) return;
    await this.deps.sessions.respondPermission(
      session,
      permissionId,
      payload.values.decision === "denied" ? "deny" : "allow",
      payload.user.id,
      { actor: { type: "user", id: payload.user.id }, meta: {} },
    );
  }

  /**
   * The turn is over (spec §5.3 "finishes with a diff_card, Open in IDE, and a PR link"). What the
   * agent left behind is committed on a branch of its own, pushed when there is a connection to
   * push with, and opened as a pull request — through the same gates a person's commit goes
   * through, secret scan included (task 2.12).
   */
  private async finished(sessionId: string): Promise<void> {
    const where = await this.inThread(sessionId);
    if (!where) return;
    const project = (await listProjects(this.deps.db, where.channel.workspaceId)).find(
      (row) => row.id === where.session.projectId,
    );
    if (!project) return;
    if (where.bot.spec.pullRequest === false) {
      await this.post(where, [
        {
          type: "diff_card",
          sessionId,
          summary: "Done. The work is in the session.",
          url: await this.sessionUrl(project, sessionId),
        },
      ]);
      return;
    }
    try {
      const link = await projectRunnerLink(this.deps.runners, project, where.session.userId);
      const said = where.session.title ?? "a change";
      const shipped = await ship(
        {
          db: this.deps.db,
          policy: this.deps.policy,
          connections: this.deps.connections,
          log: this.deps.log,
        },
        {
          project,
          link,
          userId: where.session.userId,
          author: { name: where.bot.name, email: `${where.bot.handle}@bots.perch.local` },
          branch: branchName(where.bot.handle, said),
          message: `${said}\n\nOpened from a chat by @${where.bot.handle}.`,
          ...(await this.pushConnection(where.bot, project, where.session.userId)),
          title: said,
          body: `Asked for in Perch, done by @${where.bot.handle}.`,
          by: { actor: { type: "bot", id: where.bot.id }, meta: {} },
        },
      );
      const summary =
        shipped.changed === 0
          ? "Done. Nothing changed on disk."
          : `Done. ${shipped.changed} file${shipped.changed === 1 ? "" : "s"} on ${shipped.branch}.`;
      await this.post(where, [
        {
          type: "diff_card",
          sessionId,
          summary,
          ...(shipped.note ? { text: shipped.note } : {}),
          url: await this.sessionUrl(project, sessionId),
          ...(shipped.pullRequest
            ? { prUrl: shipped.pullRequest.url, prNumber: shipped.pullRequest.number }
            : {}),
        },
      ]);
    } catch (error) {
      const said = error instanceof PerchError ? error.message : "that change would not ship";
      this.deps.log.warn({ err: error, sessionId }, "an agent bot's work did not ship");
      await this.post(where, [
        { type: "diff_card", sessionId, summary: "Done, but not shipped.", text: said },
      ]);
    }
  }

  /**
   * What to push with. The bot may say, which is what an admin who cares will do; otherwise a
   * connection for the repository's own host, and otherwise the workspace's only one — a guess
   * that can only be right when there is nothing else it could have meant.
   */
  private async pushConnection(
    bot: Bot,
    project: Project,
    userId: string,
  ): Promise<{ connectionId?: string }> {
    if (!project.repoUrl) return {};
    const rows = (await listConnections(this.deps.db, project.workspaceId, userId)).filter(
      (row) => row.status === "active",
    );
    const said = bot.spec.connection;
    if (said) {
      const named = rows.find((row) => row.id === said || row.provider === said);
      return named ? { connectionId: named.id } : {};
    }
    const host = hostOf(project.repoUrl);
    const sameHost = rows.filter((row) => host.includes(row.provider));
    const chosen =
      sameHost.find((row) => row.ownerType === "workspace") ??
      sameHost[0] ??
      (rows.length === 1 ? rows[0] : undefined);
    return chosen ? { connectionId: chosen.id } : {};
  }

  /** What went wrong, said where it was asked rather than only in the session. */
  private async failed(sessionId: string, message: string): Promise<void> {
    const where = await this.inThread(sessionId);
    if (!where) return;
    await this.post(where, [{ type: "text", text: `That did not work out: ${message}` }]);
  }

  private guard(what: string, run: () => Promise<void>): void {
    void run().catch((error: unknown) => {
      // A card that fails is a card somebody does not see, never the session that caused it.
      this.deps.log.warn({ err: error }, `agent bots: ${what} failed`);
    });
  }

  start(): Unsubscribe {
    const offs: Unsubscribe[] = [
      this.deps.bus.subscribe("session.permission_requested", (event) => {
        this.guard("a permission", () => this.askedPermission(event.payload));
      }),
      this.deps.bus.subscribe("session.done", (event) => {
        this.guard("finishing", () => this.finished(event.payload.sessionId));
      }),
      this.deps.bus.subscribe("session.error", (event) => {
        this.guard("an error", () => this.failed(event.payload.sessionId, event.payload.message));
      }),
      this.deps.botEvents.subscribe((event) => {
        if (event.type !== "interaction.received") return;
        const payload = event.payload as InteractionReceived;
        if (payload.action !== SESSION_PERMISSION_ACTION) return;
        this.guard("an answer", () => this.answered(payload));
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }
}

/** Whether a project is one of the names or ids a bot's spec listed. */
function matches(project: Project, wanted: readonly string[]): boolean {
  return wanted.some(
    (one) => one === project.id || one.toLowerCase() === project.name.toLowerCase(),
  );
}

function hostOf(repoUrl: string): string {
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/.exec(repoUrl.trim());
  if (scp?.[1]) return scp[1].toLowerCase();
  try {
    return new URL(repoUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}
