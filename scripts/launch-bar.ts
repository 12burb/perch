#!/usr/bin/env bun
/**
 * The launch bar (task 4.13; spec §2 "Phase 4 … Exit": "public beta where compose and `curl | sh`
 * work for strangers; time-to-first-agent-PR under 10 minutes").
 *
 * Four numbers, in one place, so the thing the phase is judged on is a table rather than a feeling.
 * Each is measured where that path actually runs — a stranger's two ways in, and the loop they came
 * for — and each asserts its own budget there, so the bar fails in the job that broke it rather
 * than in a report nobody reads.
 *
 * Usage:
 *   bun scripts/launch-bar.ts                     # print the bar and where each leg is proved
 *   bun scripts/launch-bar.ts --from <file.json>  # check measurements, exit 1 on any over budget
 *   bun scripts/launch-bar.ts --record <id>=<ms> --into <file.json>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Leg = {
  id: string;
  /** What is being timed, from what to what. */
  label: string;
  /** Milliseconds. Over it, the bar fails. */
  budgetMs: number;
  /** Where the number comes from, so a failure has somewhere to go. */
  provedBy: string;
};

/**
 * Ten minutes is the spec's number and it belongs to the whole loop, not to one leg — a stranger
 * who spends nine minutes pulling images has not got there in ten. The two ways in are budgeted
 * inside it, generously, because they run on whatever CI runner and whatever network the day gives
 * them; the loop itself gets the number the spec names.
 */
export const BAR: readonly Leg[] = [
  {
    id: "compose-up",
    label: "docker compose up → the wizard answers and an admin is signed in",
    budgetMs: 10 * 60_000,
    provedBy: "the compose smoke (.github/workflows/ci.yml → scripts/compose-smoke.ts)",
  },
  {
    id: "curl-sh",
    label: "curl | sh → a perch binary on the path, checksum checked",
    budgetMs: 5 * 60_000,
    provedBy: "apps/cli/test/install.test.ts against a stand-in release server",
  },
  {
    id: "laptop-boot",
    label: "perch dev → an instance serving on PGlite, with a runner",
    budgetMs: 2 * 60_000,
    provedBy: "apps/cli/test/laptop.test.ts",
  },
  {
    id: "first-agent-pr",
    label: "a stranger arrives → an agent's pull request is open",
    budgetMs: 10 * 60_000,
    provedBy: "e2e/phase4.e2e.ts (the phase4 Playwright project)",
  },
];

export function leg(id: string): Leg | undefined {
  return BAR.find((one) => one.id === id);
}

export type Measured = Record<string, number>;

export type Result = {
  leg: Leg;
  ms: number | null;
  /** Null when nothing measured it: not a pass, and not the same failure as being over. */
  ok: boolean | null;
};

export function check(measured: Measured): Result[] {
  return BAR.map((one) => {
    const ms = measured[one.id];
    if (typeof ms !== "number" || !Number.isFinite(ms)) return { leg: one, ms: null, ok: null };
    return { leg: one, ms, ok: ms <= one.budgetMs };
  });
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function report(results: Result[]): string {
  const lines = results.map((result) => {
    const mark = result.ok === null ? "  ? " : result.ok ? "ok  " : "OVER";
    const took = result.ms === null ? "not measured" : seconds(result.ms);
    return [
      `${mark}  ${result.leg.id.padEnd(15)} ${took.padStart(13)}  (budget ${seconds(result.leg.budgetMs)})`,
      `        ${result.leg.label}`,
      `        proved by ${result.leg.provedBy}`,
    ].join("\n");
  });
  return lines.join("\n\n");
}

/** True when nothing is over budget. A leg nobody measured is not over budget; it is unproved. */
export function holds(results: Result[]): boolean {
  return results.every((one) => one.ok !== false);
}

/** Records one measurement beside any others, so a run that produces several accumulates them. */
export function record(id: string, ms: number, into: string): Measured {
  if (!leg(id)) throw new Error(`no such leg of the launch bar: ${id}`);
  const existing: Measured = existsSync(into)
    ? (JSON.parse(readFileSync(into, "utf8")) as Measured)
    : {};
  const next = { ...existing, [id]: Math.round(ms) };
  mkdirSync(dirname(into), { recursive: true });
  writeFileSync(into, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Asserts one leg where it is measured, and says the number either way — a leg that passes quietly
 * teaches nobody what the headroom is.
 */
export function within(id: string, ms: number): void {
  const one = leg(id);
  if (!one) throw new Error(`no such leg of the launch bar: ${id}`);
  const note = `launch bar ${id}: ${seconds(ms)} of ${seconds(one.budgetMs)}`;
  if (ms > one.budgetMs) throw new Error(`${note} — over budget (${one.label})`);
  console.log(note);
}

/**
 * Run as a command, rather than imported. `import.meta.main` would be the Bun way to ask, but this
 * module is also imported by a Playwright spec, and Playwright's loader compiles away `import.meta`
 * (task 4.13). Asking argv works under both.
 */
const asCommand = /launch-bar\.ts$/.test(process.argv[1] ?? "");

if (asCommand) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const into = value("--into") ?? "test-results/launch-bar.json";
  const pair = value("--record");
  if (pair) {
    const [id = "", ms = ""] = pair.split("=");
    record(id, Number(ms), into);
    console.log(`launch bar: ${id} = ${ms} ms recorded in ${into}`);
  } else {
    const from = value("--from");
    const measured: Measured =
      from && existsSync(from) ? (JSON.parse(readFileSync(from, "utf8")) as Measured) : {};
    const results = check(measured);
    console.log(report(results));
    if (!holds(results)) {
      console.error("\nthe launch bar does not hold");
      process.exit(1);
    }
    const unproved = results.filter((one) => one.ok === null).length;
    console.log(
      from
        ? `\nthe launch bar holds${unproved ? ` (${unproved} leg(s) not measured in this run)` : ""}`
        : "\nthese are the budgets; each leg is measured where it runs",
    );
  }
}
