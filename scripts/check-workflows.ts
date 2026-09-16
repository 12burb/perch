/**
 * Every GitHub workflow parses (task 3.21's fix-forward).
 *
 * A workflow with a syntax error does not fail loudly: GitHub runs it anyway, names the run after
 * the file instead of the workflow, and fails it — so the first sign is a red `main`. The local
 * gate never looked at these files at all, which is how a colon inside an unquoted step name got
 * pushed. One parse is cheap and would have caught it.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DIR = ".github/workflows";

type Workflow = { name?: unknown; jobs?: Record<string, unknown> };

let bad = 0;
for (const file of readdirSync(DIR).filter((one) => /\.ya?ml$/.test(one))) {
  const path = join(DIR, file);
  try {
    const document = parse(await Bun.file(path).text()) as Workflow | null;
    if (!document || typeof document !== "object") throw new Error("it is not a mapping");
    const jobs = Object.keys(document.jobs ?? {});
    if (jobs.length === 0) throw new Error("it has no jobs");
    // A workflow with no name is named after its file, which is also what a broken one looks like.
    if (typeof document.name !== "string" || !document.name) throw new Error("it has no name");
    console.log(`ok    ${path} — ${document.name}: ${jobs.join(", ")}`);
  } catch (error) {
    bad += 1;
    console.error(`FAIL  ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (bad > 0) {
  console.error(`\n${bad} workflow${bad === 1 ? "" : "s"} would not run.`);
  process.exit(1);
}
