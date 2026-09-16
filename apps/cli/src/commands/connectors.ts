/**
 * `perch connectors check [dir]`: the manifest harness (spec §5.5 "Everything else via manifests";
 * task 3.11) on a file somebody is writing.
 *
 * A connector in Perch is a YAML file — either one this build ships or one dropped into
 * `PERCH_CONNECTORS_DIR` — so the person adding a provider is editing YAML with no code to run and
 * nothing to tell them whether it works until the first connection fails. This tells them: every
 * check `checkManifest` makes, one line each, exit 1 if any of them is an error.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { checkManifest, reportLines } from "@perch/connect";

const USAGE = `perch connectors check [dir|file]

Checks connector manifests: a directory of <id>/manifest.yaml, or one manifest file.
Defaults to $PERCH_CONNECTORS_DIR, else ./connectors.

Options:
  --json    print the reports as JSON
  --help    show this help`;

/** Every manifest under a path: one file, or a directory of `<id>/manifest.yaml`. */
export function manifestsAt(path: string): { id: string; source: string }[] {
  if (statSync(path).isFile()) {
    // A connector's id is the directory the manifest sits in, which `dirname` gets right whichever
    // separator this machine writes paths with.
    return [{ id: basename(dirname(path)), source: readFileSync(path, "utf8") }];
  }
  const found: { id: string; source: string }[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      found.push({
        id: entry.name,
        source: readFileSync(join(path, entry.name, "manifest.yaml"), "utf8"),
      });
    } catch {
      // A directory without a manifest is not a connector; `src/` next to them is the usual one.
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

export async function runConnectors(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== "check") {
    console.error(`unknown connectors command: ${sub}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const path = positionals[0] ?? process.env.PERCH_CONNECTORS_DIR ?? "connectors";
  let manifests: { id: string; source: string }[];
  try {
    manifests = manifestsAt(path);
  } catch (error) {
    console.error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (manifests.length === 0) {
    console.error(`no connector manifests under ${path}`);
    return 1;
  }

  const reports = await Promise.all(
    manifests.map(({ id, source }) => checkManifest(source, id || undefined)),
  );
  if (values.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const report of reports) for (const line of reportLines(report)) console.log(line);
  }
  const bad = reports.filter((one) => !one.ok).length;
  if (!values.json) {
    console.log(
      bad === 0
        ? `\n${reports.length} manifest${reports.length === 1 ? "" : "s"} checked, all usable`
        : `\n${bad} of ${reports.length} would not work`,
    );
  }
  return bad === 0 ? 0 : 1;
}
