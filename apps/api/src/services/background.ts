/**
 * Background sessions (spec §5.7 "background by default: sessions keep running when the tab or
 * laptop closes; every state change posts to the task's thread; the phone gets what needs a
 * human"; task 3.17).
 *
 * Every session already runs on the api rather than in a browser, so "it keeps running when the
 * tab closes" is a fact about the architecture rather than a feature. What was missing is the
 * other two thirds: somewhere for a run nobody is watching to say what it is doing, and a rule
 * about when that is allowed to reach a phone.
 *
 * So a background session is an ordinary unattended session (ADR-0133) with a channel to report
 * in, and this keeps **one card** rewritten in place for it. Not a message per event: somebody
 * reading it in the morning wants the run, not its notifications.
 */
import type { Bus, Unsubscribe } from "@perch/bus";
import type { Db, DbHandle, MessageBlock, Project, ProjectConfig } from "@perch/db";
import type { SessionEvent } from "@perch/events";
import type { Vault } from "@perch/vault";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { getChannel } from "../repos/channels.ts";
import { getMessage, insertMessage, updateMessageBlocks } from "../repos/messages.ts";
import { findProject } from "../repos/projects.ts";
import { getSession, listEvents, updateSession } from "../repos/sessions.ts";
import { findWorkspaceById } from "../repos/workspaces.ts";
import { notify } from "./push.ts";
import type { SessionService } from "./sessions.ts";
import { WakeMemory } from "./wake-memory.ts";

export type BackgroundDeps = {
  db: DbHandle;
  bus: Bus;
  log: Logger;
  vault: Vault;
  env: { publicUrl: string };
  sessions: Pick<SessionService, "create" | "sendTurn">;
  /** Overridable so a test can be the push service. */
  fetcher?: typeof fetch;
};

export type StartBackground = {
  project: Project;
  prompt: string;
  userId: string;
  by: ActorContext;
  /** Where the card goes. A run with nowhere to report is a run nobody will read. */
  channelId: string;
  threadRootId?: string | null | undefined;
  engine?: string | undefined;
  agent?: string | undefined;
  /** A worktree of its own, when it should not write in the project checkout (task 3.14). */
  worktree?: string | undefined;
};

/** When a run is allowed to reach a phone. */
export type NotifyWhen = NonNullable<NonNullable<ProjectConfig["background"]>["notify"]>;

type Counted = {
  tools: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  text: string;
  waitingOn: string;
};

export class BackgroundService {
  constructor(private readonly deps: BackgroundDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  /**
   * Open one and let it go. The first turn is sent without waiting for it: what the caller gets
   * back is the card, because the run is the card's to report from here on.
   */
  async start(input: StartBackground): Promise<{ sessionId: string; cardMessageId: string }> {
    const prompt = input.prompt.trim();
    if (!prompt) throw PerchError.validation("say what it should do overnight");
    const channel = await getChannel(this.db, input.channelId);
    if (!channel || channel.workspaceId !== input.project.workspaceId) {
      throw PerchError.notFound("channel");
    }

    const session = await this.deps.sessions.create({
      project: input.project,
      userId: input.userId,
      by: input.by,
      title: prompt.slice(0, 120),
      channelId: channel.id,
      threadRootId: input.threadRootId ?? null,
      // The whole point: it runs to a finish line and lets go of its runner (ADR-0133).
      unattended: true,
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
    });

    const card = await insertMessage(this.db, {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      authorType: "system",
      authorId: input.userId,
      blocks: [
        await this.block(session.id, {
          state: "running",
          prompt,
          project: input.project,
          turns: 0,
        }),
      ],
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
    });
    await updateSession(this.db, session.id, { cardMessageId: card.id });
    await this.deps.bus.publish(
      "message.created",
      {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        messageId: card.id,
        authorType: "system",
        authorId: input.userId,
        ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      },
      input.by,
    );

    // The turn runs behind the response: a background session is not something a caller waits on.
    void this.deps.sessions
      .sendTurn(session, input.userId, { text: prompt }, { by: input.by })
      .catch((error: unknown) => {
        this.deps.log.warn(
          { err: error, sessionId: session.id },
          "a background session's first turn did not start",
        );
      });

    return { sessionId: session.id, cardMessageId: card.id };
  }

  /** The bus half: every state change rewrites the card, and some of them wake a phone. */
  watch(): Unsubscribe {
    const offs: Unsubscribe[] = [
      this.deps.bus.subscribe("session.status", (event) => {
        void this.changed(event.payload.sessionId).catch(this.complain(event.payload.sessionId));
      }),
      this.deps.bus.subscribe("session.permission_requested", (event) => {
        void this.changed(event.payload.sessionId).catch(this.complain(event.payload.sessionId));
      }),
      this.deps.bus.subscribe("session.done", (event) => {
        void this.changed(event.payload.sessionId).catch(this.complain(event.payload.sessionId));
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  private complain(sessionId: string) {
    return (error: unknown) => {
      this.deps.log.warn({ err: error, sessionId }, "a background card was not rewritten");
    };
  }

  private async changed(sessionId: string): Promise<void> {
    const session = await getSession(this.db, sessionId);
    if (!session?.cardMessageId || !session.channelId) return;
    const project = await findProject(this.db, session.workspaceId, session.projectId);
    if (!project) return;

    const state =
      session.status === "ended"
        ? "done"
        : session.status === "error"
          ? "failed"
          : session.status === "needs_you"
            ? "needs_you"
            : "running";
    const block = await this.block(session.id, {
      state,
      prompt: session.title ?? "",
      project,
      turns: session.turns,
      costUsd: session.costUsd,
      ...(session.statusMessage ? { detail: session.statusMessage } : {}),
      ...(state === "done" || state === "failed"
        ? { elapsedMs: Math.max(0, Date.now() - session.startedAt.getTime()) }
        : {}),
    });

    const card = await getMessage(this.db, session.cardMessageId);
    if (!card) return;
    // Rewriting its own status line, not editing somebody's message: no edit history (task 3.15).
    await updateMessageBlocks(this.db, card, [block], {
      type: "system",
      id: session.id,
      history: false,
    });

    await this.maybeWake(project, session.id, state, block);
  }

  /**
   * The phone, when the project says so. `needs_you` is the default because that is the whole
   * promise: a run that is getting on with it is a card to read later, and a run that is stuck is
   * somebody's evening.
   */
  private async maybeWake(
    project: Project,
    sessionId: string,
    state: "running" | "needs_you" | "done" | "failed",
    block: MessageBlock & { type: "background_card" },
  ): Promise<void> {
    const when: NotifyWhen = project.config?.background?.notify ?? "needs_you";
    if (when === "never") return;
    const needed = state === "needs_you" || state === "failed";
    if (!needed && !(when === "always" && state === "done")) return;
    // Once per state: a card that is rewritten five times while it waits is still one wait.
    if (!this.woke.note(sessionId, state)) return;

    const session = await getSession(this.db, sessionId);
    if (!session) return;
    const body =
      state === "needs_you"
        ? (block.waitingOn ?? "It is waiting on you")
        : state === "failed"
          ? (block.detail ?? "It stopped")
          : (block.text ?? "Finished");
    try {
      await notify(
        { db: this.deps.db, vault: this.deps.vault, env: this.deps.env },
        session.userId,
        {
          title: `${project.name}: ${session.title ?? "a background session"}`,
          body: body.slice(0, 140),
          url: block.url ?? "",
          // One per session: an evening of state changes replaces itself on the phone.
          tag: `session:${sessionId}`,
        },
        this.deps.fetcher ?? fetch,
      );
    } catch (error) {
      // A push that fails is a notification somebody misses, never a run that fails.
      this.deps.log.warn({ err: error, sessionId }, "a background session's push failed");
    }
  }

  /** What each session was last woken about, so one wait is one notification (bounded, ADR-0168). */
  private readonly woke = new WakeMemory();

  /** The card, counted from the transcript the session has written so far. */
  private async block(
    sessionId: string,
    input: {
      state: "running" | "needs_you" | "done" | "failed";
      prompt: string;
      project: Project;
      turns: number;
      costUsd?: number;
      detail?: string;
      elapsedMs?: number;
    },
  ): Promise<MessageBlock & { type: "background_card" }> {
    const counted = await this.count(sessionId);
    const workspace = await findWorkspaceById(this.db, input.project.workspaceId);
    return {
      type: "background_card",
      sessionId,
      state: input.state,
      prompt: input.prompt.slice(0, 2000),
      url: `/${workspace?.slug ?? input.project.workspaceId}/code/${input.project.key}?session=${sessionId}`,
      turns: input.turns,
      tools: counted.tools,
      filesChanged: counted.filesChanged,
      additions: counted.additions,
      deletions: counted.deletions,
      ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
      ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
      ...(counted.text ? { text: counted.text.slice(0, 4000) } : {}),
      ...(input.state === "needs_you" && counted.waitingOn
        ? { waitingOn: counted.waitingOn.slice(0, 200) }
        : {}),
      ...(input.detail ? { detail: input.detail.slice(0, 2000) } : {}),
    };
  }

  /**
   * The run so far, out of its own transcript: how many tools it ran, what it touched, and the
   * last thing it said. The transcript is the record either way — this is the summary of it that
   * fits on a card.
   */
  private async count(sessionId: string): Promise<Counted> {
    const out: Counted = {
      tools: 0,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      text: "",
      waitingOn: "",
    };
    const touched = new Set<string>();
    let said = "";
    for (let after = 0; ; ) {
      const rows = await listEvents(this.db, sessionId, after, 500);
      if (rows.length === 0) break;
      for (const row of rows) {
        const event = row.event as SessionEvent;
        if (event.type === "tool_call") out.tools += 1;
        if (event.type === "permission") out.waitingOn = event.tool;
        if (event.type === "text") said += event.delta;
        if (event.type === "turn") said = "";
        if (event.type === "tool_result" && event.diff) {
          for (const file of event.diff) {
            touched.add(file.path);
            out.additions += file.additions ?? 0;
            out.deletions += file.deletions ?? 0;
          }
        }
      }
      after = rows[rows.length - 1]?.seq ?? after;
      if (rows.length < 500) break;
    }
    out.filesChanged = touched.size;
    out.text = said.trim();
    return out;
  }
}
