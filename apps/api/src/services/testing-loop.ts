/**
 * The testing loop (spec §5.7 "testing loop: failing tests → bounded auto-fix loop with budget";
 * task 3.18).
 *
 * When a round finishes having written something, the project's own tests run on what it wrote. If
 * they fail, the failure goes back to the agent as the next turn — the command, and the tail of
 * what it said — and the agent gets another go. After a bounded number of those the loop stops and
 * asks a person, because an agent that cannot fix what it broke will not fix it on the fifth try
 * either, and every try is somebody's money.
 *
 * It hooks the end of a round rather than subscribing to the bus, for one reason: an unattended
 * session settles the moment its round goes quiet (ADR-0133), and a session that has ended cannot
 * be told anything. So the loop answers first, and holds the session open when it has something
 * to say.
 */
import type { CodingSession, Db, DbHandle, Project } from "@perch/db";
import {
  execResultSchema,
  type RunnerLink,
  type SessionEvent,
  worktreeCreateResultSchema,
} from "@perch/events";
import type { Logger } from "pino";
import { findProject } from "../repos/projects.ts";
import { getSession, listEvents, updateSession } from "../repos/sessions.ts";
import { projectRunnerLink } from "./projects.ts";
import { runnerCall } from "./runners.ts";
import type { SessionService } from "./sessions.ts";

export type TestingLoopDeps = {
  db: DbHandle;
  log: Logger;
  sessions: Pick<SessionService, "sendTurn" | "park" | "settle">;
  registry: Parameters<typeof projectRunnerLink>[0]["registry"];
  /** How long the project's tests get. */
  testTimeoutMs?: number;
};

/** The first of these in the project's `run` map is what "its tests" means (ADR-0135). */
const TEST_KEYS = ["test", "check", "ci", "verify"] as const;

const TEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ATTEMPTS = 2;
/** How much of a failure the agent is shown. Enough to work from, not enough to drown a context. */
const TAIL = 4_000;

export class TestingLoopService {
  constructor(private readonly deps: TestingLoopDeps) {}

  private get db(): Db {
    return this.deps.db.db;
  }

  /** Turns the loop has scheduled but not yet sent, so shutting down does not leave one firing. */
  private readonly sending = new Set<ReturnType<typeof setTimeout>>();

  /** The project's tests, when it names any. */
  static testCommand(project: Project): { key: string; command: string } | null {
    const run = project.config.run ?? {};
    for (const key of TEST_KEYS) {
      const command = run[key];
      if (command) return { key, command };
    }
    return null;
  }

  close(): void {
    for (const timer of this.sending) clearTimeout(timer);
    this.sending.clear();
  }

  /**
   * A round has gone quiet. Returns true when the session should stay open because another turn
   * is coming.
   */
  async afterRound(session: CodingSession): Promise<boolean> {
    const project = await findProject(this.db, session.workspaceId, session.projectId);
    if (!project) return false;
    const loop = project.config.background?.testLoop;
    // Absent means off, and `enabled: false` means off out loud.
    if (!loop || loop.enabled === false) return false;
    const tests = TestingLoopService.testCommand(project);
    if (!tests) return false;
    // A round that answered a question rather than writing anything has nothing to test.
    if (!(await this.wrote(session))) return false;

    const attempts = loop.attempts ?? DEFAULT_ATTEMPTS;
    const result = await this.run(project, session, tests.command);
    if (!result) return false;
    if (result.exitCode === 0) {
      // Green again: the next thing a person says starts the count over.
      if (session.fixAttempts > 0) await updateSession(this.db, session.id, { fixAttempts: 0 });
      return false;
    }

    const told = session.fixAttempts;
    if (told >= attempts) {
      // The bound. It stops here and says what still fails, where the inbox and the card read it.
      await this.deps.sessions.park(
        session,
        `${tests.command} still fails after ${told} ${told === 1 ? "try" : "tries"}:\n${result.output}`,
      );
      return true;
    }

    await updateSession(this.db, session.id, { fixAttempts: told + 1 });
    this.later(session, tests.command, result.output);
    return true;
  }

  /**
   * The next turn, sent once this round has let go of the session. A round is still on the books
   * while its own ending is being handled, and a turn sent into that is a `409`.
   */
  private later(session: CodingSession, command: string, output: string): void {
    const timer = setTimeout(() => {
      this.sending.delete(timer);
      void this.tell(session, command, output).catch((error: unknown) => {
        this.deps.log.warn(
          { err: error, sessionId: session.id },
          "the testing loop could not send its turn",
        );
        // Nothing else is coming, so the session should not be left holding a runner.
        void this.deps.sessions.settle(session).catch(() => undefined);
      });
    }, 0);
    this.sending.add(timer);
  }

  private async tell(session: CodingSession, command: string, output: string): Promise<void> {
    const fresh = await getSession(this.db, session.id);
    if (!fresh || fresh.status === "ended" || fresh.status === "needs_you") return;
    await this.deps.sessions.sendTurn(
      fresh,
      fresh.userId,
      {
        text: [
          `The project's tests fail after your change. \`${command}\` said:`,
          "",
          output,
          "",
          "Fix it, then stop. Do not change the tests to make them pass.",
        ].join("\n"),
      },
      { by: { actor: { type: "system" }, meta: {} } },
    );
  }

  /** Did this round write anything? The transcript knows: a `tool_result` carrying a diff. */
  private async wrote(session: CodingSession): Promise<boolean> {
    const from = Math.max(0, session.lastSeq - 500);
    const rows = await listEvents(this.db, session.id, from, 500);
    const events = rows.map((row) => row.event as SessionEvent);
    let since = 0;
    for (const [index, event] of events.entries()) {
      if (event.type === "turn") since = index;
    }
    // Without a turn in the window this is a long round, and a long round almost certainly wrote.
    if (events.length > 0 && since === 0 && events[0]?.type !== "turn") return true;
    return events
      .slice(since)
      .some((event) => event.type === "tool_result" && (event.diff?.length ?? 0) > 0);
  }

  /** The tests, where the session works: its worktree when it has one, the checkout otherwise. */
  private async run(
    project: Project,
    session: CodingSession,
    command: string,
  ): Promise<{ exitCode: number; output: string } | null> {
    let link: RunnerLink;
    try {
      link = await projectRunnerLink(
        { db: this.db, registry: this.deps.registry },
        project,
        session.userId,
      );
    } catch (error) {
      this.deps.log.warn(
        { err: error, sessionId: session.id },
        "no runner to run the project's tests on",
      );
      return null;
    }

    let cwd: string | undefined;
    if (session.worktree) {
      try {
        const raw = await runnerCall(link, "worktree.create", {
          workspace_id: project.workspaceId,
          user_id: session.userId,
          project: project.id,
          branch: session.worktree,
          base: project.defaultBranch,
        });
        cwd = worktreeCreateResultSchema.parse(raw).path;
      } catch (error) {
        this.deps.log.warn(
          { err: error, sessionId: session.id },
          "the session's worktree was not found; its tests run in the checkout",
        );
      }
    }

    try {
      const raw = await runnerCall(link, "exec", {
        workspace_id: project.workspaceId,
        user_id: session.userId,
        command,
        timeout: this.deps.testTimeoutMs ?? TEST_TIMEOUT_MS,
        // The worktree when the session has one, and otherwise the project's own directory,
        // whichever one that is on this runner.
        ...(cwd ? { cwd } : { project: project.id }),
      });
      const result = execResultSchema.parse(raw);
      return {
        exitCode: result.exitCode ?? 1,
        output: tail(`${result.stdout}\n${result.stderr}`),
      };
    } catch (error) {
      // A test command that cannot be run is not a test failure: nobody is told off for it.
      this.deps.log.warn({ err: error, sessionId: session.id }, "the project's tests did not run");
      return null;
    }
  }
}

function tail(text: string, max = TAIL): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}
