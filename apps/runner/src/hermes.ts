/**
 * The Hermes engine (spec §3.3 `hermes = Hermes Agent runtime for Nest agents`; task 3.8).
 *
 * Hermes Agent speaks ACP itself — `hermes acp` is an ACP server over stdio, with stdout reserved
 * for JSON-RPC and logs on stderr — so this is not a second protocol. It is the ACP client the
 * runner already has (task 1.9), launched the way Hermes wants and pointed at the right home, plus
 * the two things Hermes has that a registry agent does not: its own provider configuration, and a
 * model that can be chosen per run.
 *
 * Why an engine of its own rather than an entry in the ACP registry: the engine id is what a
 * project's `.perch/project.json` and a bot's spec name, and `hermes` is one of the ids spec §3.3
 * gives the Engine interface. A session that says `engine: "hermes"` should not have to also know
 * that the agent behind it happens to be called hermes.
 *
 * Credentials: none of Hermes' are Perch's. It reads `~/.hermes/config.yaml` and `~/.hermes/.env`,
 * and `HOME` is already the user's own volume (`/data/homes/<user>`), so a Nous Portal or Codex
 * subscription signed in through `hermes` in the terminal is that person's and reaches nothing
 * else — spec §3.6's Lane B, kept by doing nothing rather than by arranging anything.
 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AcpAgentSpec, AgentLaunch } from "./acp.ts";

/** The version of Hermes Agent this runner image installs (docs/dependencies.md). */
export const HERMES_VERSION = "v2026.9.14";

/**
 * How to start it, best first. `hermes acp` is the documented command; `hermes-acp` is the console
 * script the `[acp]` extra installs, and is what is left when only that extra is on PATH.
 */
export const HERMES_LAUNCHERS: AcpAgentSpec[] = [
  { name: "Hermes Agent", command: "hermes", args: ["acp"] },
  { name: "Hermes Agent", command: "hermes-acp" },
];

/** What a session's `agent` field says when the engine is hermes: there is only the one. */
export const HERMES_AGENT = { id: "hermes", name: "Hermes Agent" } as const;

function on(command: string): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  return Bun.which(command);
}

/**
 * The first launcher this machine has, or null. `PERCH_HERMES_COMMAND` overrides both, for a
 * checkout installed somewhere the PATH does not reach.
 */
export function resolveHermes(env: NodeJS.ProcessEnv = process.env): AgentLaunch | null {
  const said = env.PERCH_HERMES_COMMAND?.trim();
  if (said) {
    const [command, ...args] = said.split(/\s+/);
    const found = command ? on(command) : null;
    if (found) return { file: found, args };
    return null;
  }
  for (const spec of HERMES_LAUNCHERS) {
    const found = spec.command ? on(spec.command) : null;
    if (found) return { file: found, args: spec.args ?? [] };
  }
  return null;
}

/** Whether this runner can host a Hermes session at all. */
export function hermesInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveHermes(env) !== null;
}

/**
 * What a session's brain means to Hermes (task 1.15's ModelRef → Hermes' own selection).
 *
 * `hermes acp` publishes no flags of its own, so the model travels as `HERMES_INFERENCE_MODEL`,
 * which the CLI documents as the equivalent of `--model`. A session on the engine's own default —
 * `provider: "engine"`, or no model at all — sets nothing, and Hermes uses whatever the person
 * configured. Perch never writes a provider credential into this: choosing a model is not the same
 * as handing over a key (AGENTS.md §1.6).
 */
export function hermesEnv(model?: { provider?: string; modelId?: string }): Record<string, string> {
  const provider = model?.provider ?? "";
  const id = model?.modelId ?? "";
  if (!id || provider === "engine" || provider === "default") return {};
  // Hermes names models the way its providers do; a bare id is passed through, and a Perch-shaped
  // "provider/model" is passed through too — both are shapes its resolver reads.
  return { HERMES_INFERENCE_MODEL: id };
}
