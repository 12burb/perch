#!/usr/bin/env bun
/**
 * DCO check: every commit in a range must carry a `Signed-off-by:` trailer whose author certifies the
 * Developer Certificate of Origin 1.1 (CONTRIBUTING.md). Runs in CI on every pull request; the DCO GitHub
 * App, when installed on the repository, enforces the same rule on the merge button.
 *
 * Usage: bun scripts/check-dco.ts [<base>..<head>] [--cwd <repo>]   (range defaults to origin/main..HEAD)
 */

export type DcoResult = { ok: boolean; checked: number; failures: string[] };

const RECORD = "";
const FIELD = "";
const SIGNED_OFF = /^Signed-off-by: .+ <[^>]+>$/m;

export function checkDco(range: string, cwd?: string): DcoResult {
  const proc = Bun.spawnSync(
    ["git", "log", "--no-merges", `--format=%H${FIELD}%an <%ae>${FIELD}%B${RECORD}`, range],
    { cwd },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`git log failed: ${proc.stderr.toString().trim()}`);
  }
  const records = proc.stdout
    .toString()
    .split(RECORD)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const failures: string[] = [];
  for (const raw of records) {
    const [sha = "", author = "", body = ""] = raw.split(FIELD);
    if (!SIGNED_OFF.test(body)) {
      failures.push(`${sha.slice(0, 12)} (${author}) is missing a Signed-off-by trailer`);
    }
  }
  return { ok: failures.length === 0, checked: records.length, failures };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cwdIndex = args.indexOf("--cwd");
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
  const range = args.find((a, i) => !a.startsWith("--") && (cwdIndex < 0 || i !== cwdIndex + 1));
  const result = checkDco(range ?? "origin/main..HEAD", cwd);
  if (!result.ok) {
    console.error("DCO check failed:\n");
    for (const f of result.failures) console.error(`  - ${f}`);
    console.error(
      "\nFix with `git commit --amend -s` or `git rebase --signoff <base>` and push again.",
    );
    process.exit(1);
  }
  console.log(`DCO check passed: ${result.checked} commit(s) signed off.`);
}
