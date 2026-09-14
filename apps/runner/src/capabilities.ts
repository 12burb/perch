import { arch, platform } from "node:os";
import type { RunnerCapabilities } from "@perch/db";
import { installedAgents } from "./acp.ts";

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
      const result = Bun.spawnSync([command, "--version"]);
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

/** What this runner can do, in the shape the api stores (spec §6 runners.capabilities). */
export function localCapabilities(overrides: Partial<RunnerCapabilities> = {}): RunnerCapabilities {
  return {
    // The ACP adapter runs on every runner (task 1.9); which agents are on PATH is reported too.
    engines: ["acp"],
    agents: installedAgents(),
    pty: true,
    platform: platform(),
    arch: arch(),
    versions: { bun: Bun.version, ...detectToolVersions() },
    ...overrides,
  };
}
