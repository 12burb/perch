import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../src/env.ts";

/**
 * AGENTS.md §1.6, at the runner: nothing the runner starts sees its connect token, master key or
 * session secret. `childEnv` is the one place that rule is written down, and the last test here
 * is what keeps every process the runner starts going through it.
 */

describe("what a child of the runner starts from (ADR-0160)", () => {
  test("every PERCH_* variable is blanked, everything else is kept, the caller's own are applied as given", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/runner",
        OPENAI_API_KEY: "sk-the-users-own",
        PERCH_RUNNER_TOKEN: "prt_secret",
        PERCH_MASTER_KEY: "master",
        PERCH_SESSION_SECRET: "session",
        PERCH_API_URL: "http://api.internal",
        NOT_SET: undefined,
      },
      { PERCH: "1", PERCH_GIT_SECRET: "for-the-credential-helper" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/runner",
      OPENAI_API_KEY: "sk-the-users-own",
      PERCH_RUNNER_TOKEN: "",
      PERCH_MASTER_KEY: "",
      PERCH_SESSION_SECRET: "",
      PERCH_API_URL: "",
      PERCH: "1",
      PERCH_GIT_SECRET: "for-the-credential-helper",
    });
  });

  test("it starts from the runner's real environment", () => {
    const before = process.env.PERCH_RUNNER_TOKEN;
    process.env.PERCH_RUNNER_TOKEN = "prt_leaked";
    try {
      const env = childEnv();
      expect(env.PERCH_RUNNER_TOKEN).toBe("");
      expect(env.PATH).toBe(process.env.PATH ?? "");
    } finally {
      if (before === undefined) delete process.env.PERCH_RUNNER_TOKEN;
      else process.env.PERCH_RUNNER_TOKEN = before;
    }
  });

  test("every process the runner starts is given its environment; none inherits the runner's", () => {
    const src = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const name of readdirSync(src).sort()) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(src, name), "utf8");
      // The one file that may read the runner's environment whole is the one that blanks it.
      if (name !== "env.ts" && text.includes("...process.env")) {
        offenders.push(`${name} spreads process.env into something`);
      }
      for (const site of spawnSites(text)) {
        if (!/\benv\b/.test(site.text)) offenders.push(`${name}:${site.line} ${site.head}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Every call that starts a process: `Bun.spawn`, `Bun.spawnSync`, a `spawn` imported from
 * node:child_process or bun-pty, and `simpleGit` (which starts git). The site's text runs from the
 * call to the end of its statement, so a `.env(…)` chained onto `simpleGit(…)` counts.
 */
function spawnSites(text: string): { line: number; head: string; text: string }[] {
  const importsSpawn = /import \{[^}]*\bspawn\b[^}]*\} from/.test(text);
  const pattern = /Bun\.spawn(?:Sync)?\(|(?<![.\w])spawn\(|(?<![.\w])simpleGit\(/g;
  const sites: { line: number; head: string; text: string }[] = [];
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const before = text.slice(lineStart, at);
    // A method named spawn is not a process: `private spawn(params` in pty.ts and mcp.ts.
    if (/(?:private|public|protected|function|async)\s+$/.test(before)) continue;
    if (match[0] === "spawn(" && !importsSpawn) continue;
    let depth = 0;
    let end = at;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    // On to the end of the statement, for a chained `.env(…)`.
    const stop = text.indexOf(";", end);
    const site = text.slice(at, stop === -1 ? end + 1 : stop);
    const line = text.slice(0, at).split("\n").length;
    sites.push({ line, head: text.slice(at, text.indexOf("\n", at)).trim(), text: site });
  }
  return sites;
}
