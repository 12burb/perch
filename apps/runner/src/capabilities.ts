import { arch, platform } from "node:os";
import type { RunnerCapabilities } from "@perch/db";
import { installedAgents } from "./acp.ts";
import { agentVersions } from "./agents.ts";
import { childEnv } from "./env.ts";
import { hermesInstalled } from "./hermes.ts";
import { asUser } from "./identity.ts";
import { opencodeBinary, opencodeUrl } from "./opencode.ts";

let toolVersions: Record<string, string> | undefined;

/** `git --version` and `rg --version`, once; absent tools are simply not listed. */
export function detectToolVersions(): Record<string, string> {
  if (toolVersions) return toolVersions;
  const out: Record<string, string> = {};
  for (const [name, command] of [
    ["git", "git"],
    ["ripgrep", "rg"],
  ] as const) {
    if (!Bun.which(command)) continue;
    try {
      const run = asUser(null, [command, "--version"], childEnv());
      const result = Bun.spawnSync(run.argv, { env: run.env });
      const line = result.stdout.toString().split("\n")[0] ?? "";
      const version = /(\d+\.\d+(?:\.\d+)?)/.exec(line)?.[1];
      if (result.exitCode === 0 && version) out[name] = version;
    } catch {
      // not runnable here
    }
  }
  toolVersions = out;
  return out;
}

/**
 * What this runner can do, in the shape the api stores (spec §6 runners.capabilities).
 *
 * `versions` carries the agent CLIs too, so the Environments page can say which Codex a session
 * would start on without starting one.
 */
export function localCapabilities(overrides: Partial<RunnerCapabilities> = {}): RunnerCapabilities {
  return {
    // The ACP adapter runs on every runner (task 1.9) and OpenCode where its binary is — or where
    // PERCH_OPENCODE_URL names a server already running (task 1.10); which agents are on PATH is
    // reported too. Hermes is its own engine where it is installed (task 3.8).
    engines: [
      "acp",
      ...(opencodeBinary() || opencodeUrl() ? ["opencode"] : []),
      ...(hermesInstalled() ? ["hermes"] : []),
    ],
    agents: installedAgents(),
    pty: true,
    platform: platform(),
    arch: arch(),
    // The agent CLIs this image ships, at the versions it pinned (task 4.6), beside the tools.
    versions: { bun: Bun.version, ...detectToolVersions(), ...agentVersions() },
    ...overrides,
  };
}
