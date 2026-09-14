/**
 * Feature flags (spec §9.1: `flags.isOn(name)`, default off, removed within two releases). A flag
 * is on when the instance setting `flags` (a JSON object of name → boolean, set by an admin) says
 * so, else when PERCH_FLAGS (a comma-separated list the operator sets) names it. Every flag is
 * declared here with the release it appeared in, so the removal deadline is in the code.
 */
import { type Db, schema } from "@perch/db";
import { eq } from "drizzle-orm";

export const FLAGS = {
  /** The cli-harness engine: official CLIs in headless mode under the person's own login (spec §3.3). */
  cli_harness: {
    since: "0.2.0",
    description: "The cli-harness engine (Codex exec, Claude Code -p)",
  },
} as const;
export type FlagName = keyof typeof FLAGS;
export const FLAG_NAMES = Object.keys(FLAGS) as FlagName[];

export type Flags = {
  isOn(name: FlagName): Promise<boolean>;
  /** Every declared flag with its current state. */
  list(): Promise<Record<FlagName, boolean>>;
};

const SETTING_KEY = "flags";
const CACHE_MS = 5_000;

export function createFlags(deps: { db: Db; env: { flags: readonly string[] } }): Flags {
  let cached: { at: number; value: Record<string, unknown> } | null = null;
  async function settings(): Promise<Record<string, unknown>> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const [row] = await deps.db
      .select({ value: schema.instanceSettings.value })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.key, SETTING_KEY))
      .limit(1);
    const value =
      row && typeof row.value === "object" && row.value !== null && !Array.isArray(row.value)
        ? (row.value as Record<string, unknown>)
        : {};
    cached = { at: Date.now(), value };
    return value;
  }
  async function isOn(name: FlagName): Promise<boolean> {
    const stored = (await settings())[name];
    if (typeof stored === "boolean") return stored;
    return deps.env.flags.includes(name);
  }
  return {
    isOn,
    async list() {
      const out = {} as Record<FlagName, boolean>;
      for (const name of FLAG_NAMES) out[name] = await isOn(name);
      return out;
    },
  };
}
