/**
 * The agent CLIs this runner has, and which versions (task 4.6).
 *
 * The runner image installs four official CLIs at pinned versions and leaves `deploy/agents.json`
 * beside them at `/opt/perch/agents.json`. Reading that file is how the runner reports what it has
 * without shelling out four times at boot — and, more importantly, how a session on any of them
 * starts without fetching anything: the manifest is the same list the image installed.
 *
 * A runner with no manifest (somebody's laptop, `perch runner connect`) falls back to asking each
 * CLI its version, and reports only what is actually on PATH.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { childEnv } from "./env.ts";

/** Where the image leaves it; `PERCH_AGENT_MANIFEST` moves it. */
export const MANIFEST_PATH = "/opt/perch/agents.json";

const acpSchema = z.object({
  package: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

const agentSchema = z.object({
  name: z.string().min(1),
  package: z.string().min(1),
  /** Why this pin, where it is not obvious. */
  note: z.string().optional(),
  /** Exact: `1.2.3`, never a range. An agent that changes under a session is a change nobody chose. */
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  command: z.string().min(1),
  acp: acpSchema.optional(),
});

export const agentManifestSchema = z.object({
  manifest: z.literal("perch-agents"),
  version: z.literal(1),
  note: z.string().optional(),
  agents: z.record(z.string(), agentSchema),
});

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type AgentEntry = z.infer<typeof agentSchema>;

export function parseAgentManifest(text: string): AgentManifest {
  return agentManifestSchema.parse(JSON.parse(text));
}

let cached: AgentManifest | null | undefined;

/** The manifest this runner was built with, or null when it was not built with one. */
export function agentManifest(
  path: string = process.env.PERCH_AGENT_MANIFEST ?? MANIFEST_PATH,
): AgentManifest | null {
  if (cached !== undefined && path === (process.env.PERCH_AGENT_MANIFEST ?? MANIFEST_PATH)) {
    return cached;
  }
  let manifest: AgentManifest | null = null;
  try {
    if (existsSync(path)) manifest = parseAgentManifest(readFileSync(path, "utf8"));
  } catch {
    // A manifest that does not parse is the same as none: the runner still works, it just has to
    // ask each CLI itself.
    manifest = null;
  }
  if (path === (process.env.PERCH_AGENT_MANIFEST ?? MANIFEST_PATH)) cached = manifest;
  return manifest;
}

/** Forgets what was cached (tests, and a runner that was just upgraded in place). */
export function forgetAgentManifest(): void {
  cached = undefined;
  probed = undefined;
}

/** `codex --version` and friends, for a machine with no manifest. Absent CLIs are not listed. */
export function probeAgentVersions(commands: Record<string, string>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [id, command] of Object.entries(commands)) {
    if (!Bun.which(command)) continue;
    try {
      const result = Bun.spawnSync([command, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv(),
      });
      const line = result.stdout.toString().split("\n")[0] ?? "";
      const version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line)?.[1];
      if (result.exitCode === 0 && version) found[id] = version;
    } catch {
      // not runnable here
    }
  }
  return found;
}

let probed: Record<string, string> | undefined;

/**
 * The agent CLIs this machine has, id → version. From the manifest where there is one (and the
 * command is really on PATH), and by asking otherwise.
 *
 * Asking means four child processes, so the answer is kept: capabilities are reported on every
 * heartbeat, and a heartbeat should cost nothing.
 */
export function agentVersions(
  options: { manifest?: AgentManifest | null; which?: (command: string) => string | null } = {},
): Record<string, string> {
  const manifest = options.manifest === undefined ? agentManifest() : options.manifest;
  const which = options.which ?? ((command: string) => Bun.which(command));
  if (!manifest) {
    probed ??= probeAgentVersions({
      codex: "codex",
      claude: "claude",
      gemini: "gemini",
      opencode: "opencode",
    });
    return probed;
  }
  const versions: Record<string, string> = {};
  for (const [id, agent] of Object.entries(manifest.agents)) {
    // The manifest says what was installed; PATH says whether it still is.
    if (which(agent.command)) versions[id] = agent.version;
  }
  return versions;
}
