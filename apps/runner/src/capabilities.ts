import { arch, platform } from "node:os";
import type { RunnerCapabilities } from "@perch/db";

/** What this runner can do, in the shape the api stores (spec §6 runners.capabilities). */
export function localCapabilities(overrides: Partial<RunnerCapabilities> = {}): RunnerCapabilities {
  return {
    engines: [],
    pty: false,
    platform: platform(),
    arch: arch(),
    versions: { bun: Bun.version },
    ...overrides,
  };
}
