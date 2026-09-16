/**
 * Preflight before push (spec §5.6 "Preflight before push: run test/lint/build from project.json,
 * then an agent visual smoke over the configured routes (screenshot each, fail on console errors)
 * → checklist card; configurable warn or block"; task 3.21).
 *
 * Two halves. The first is the project's own commands, which is what CI would have said in ten
 * minutes' time. The second is the half a test suite cannot do: open each of the project's routes
 * in a browser and look at it — a page that throws on load passes every unit test ever written.
 *
 * What comes back is a checklist, not a log. A row per thing checked, and for the ones that failed,
 * the reason and nothing else: preflight is read at the moment somebody is trying to push.
 */
import type { Project } from "@perch/db";
import { execResultSchema, type RunnerLink, screenshotResultSchema } from "@perch/events";
import type { Logger } from "pino";
import { runnerCall } from "./runners.ts";

export type PreflightVerdict = "off" | "warn" | "block";

export type PreflightRow = {
  name: string;
  kind: "command" | "route";
  ok: boolean;
  detail?: string;
  /** The picture of a route, when one was taken and somewhere was found to keep it. */
  png?: string;
};

export type PreflightResult = {
  verdict: Exclude<PreflightVerdict, "off">;
  passed: boolean;
  rows: PreflightRow[];
};

export type PreflightDeps = {
  log: Logger;
  /** How long each of the project's own commands gets. */
  commandTimeoutMs?: number;
};

/** The commands preflight runs, in the order a person would: fast ones first. */
const COMMANDS = ["lint", "test", "build"] as const;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const TAIL = 2_000;

/** What the project says to do about a failure; absent is off. */
export function preflightVerdict(project: Project): PreflightVerdict {
  return project.config.preview?.preflight ?? "off";
}

export class PreflightService {
  constructor(private readonly deps: PreflightDeps) {}

  /**
   * Run it. A project with no commands and no routes passes a preflight of nothing, which is the
   * honest answer — it has not told us what "ready" means.
   */
  async run(input: {
    project: Project;
    link: RunnerLink;
    userId: string;
    /** The dev server's port, when one is up. Without it the routes are not looked at. */
    port?: number | undefined;
  }): Promise<PreflightResult> {
    const verdict = preflightVerdict(input.project);
    const rows: PreflightRow[] = [...(await this.commands(input)), ...(await this.routes(input))];
    return {
      verdict: verdict === "off" ? "warn" : verdict,
      passed: rows.every((one) => one.ok),
      rows,
    };
  }

  /** The project's own lint, test and build — whichever of them it has. */
  private async commands(input: {
    project: Project;
    link: RunnerLink;
    userId: string;
  }): Promise<PreflightRow[]> {
    const run = input.project.config.run ?? {};
    const rows: PreflightRow[] = [];
    for (const key of COMMANDS) {
      const command = run[key];
      if (!command) continue;
      try {
        const raw = await runnerCall(input.link, "exec", {
          workspace_id: input.project.workspaceId,
          user_id: input.userId,
          project: input.project.id,
          command,
          timeout: this.deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
        });
        const result = execResultSchema.parse(raw);
        const ok = (result.exitCode ?? 1) === 0;
        rows.push({
          name: `${key}: ${command}`,
          kind: "command",
          ok,
          ...(ok ? {} : { detail: tail(`${result.stdout}\n${result.stderr}`) }),
        });
      } catch (error) {
        // A command that could not be run is not a command that passed.
        rows.push({
          name: `${key}: ${command}`,
          kind: "command",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows;
  }

  /**
   * Each configured route, opened in the runner's own browser. A console error or a request that
   * did not come back is a failure: both are things a person would have noticed and a suite does
   * not.
   */
  private async routes(input: {
    project: Project;
    link: RunnerLink;
    userId: string;
    port?: number | undefined;
  }): Promise<PreflightRow[]> {
    const routes = input.project.config.preview?.routes ?? [];
    if (routes.length === 0) return [];
    if (!input.port) {
      return [
        {
          name: "the preview",
          kind: "route",
          ok: false,
          detail: "nothing is serving this project's preview, so its routes were not looked at",
        },
      ];
    }

    const rows: PreflightRow[] = [];
    for (const route of routes.slice(0, 20)) {
      try {
        const raw = await runnerCall(input.link, "preview.screenshot", {
          workspace_id: input.project.workspaceId,
          user_id: input.userId,
          port: input.port,
          path: route,
        });
        const seen = screenshotResultSchema.parse(raw);
        const errors = (seen.console ?? []).filter((one) => one.level === "error");
        const failed = seen.failed ?? [];
        const why = [
          ...errors.map((one) => one.text),
          ...failed.map((one) => `${one.status} ${one.url}`),
        ];
        rows.push({
          name: route,
          kind: "route",
          ok: why.length === 0,
          png: seen.png,
          ...(why.length === 0 ? {} : { detail: tail(why.join("\n")) }),
        });
      } catch (error) {
        rows.push({
          name: route,
          kind: "route",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows;
  }
}

function tail(text: string, max = TAIL): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}
