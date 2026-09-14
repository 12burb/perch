/**
 * `perch runner connect <url>` (spec §3.2, task 1.3): this machine becomes one of your environments.
 * The token comes from the Environments page ("Connect a machine"), which shows it once; the runner
 * serves its owner only. Runs until Ctrl-C; reconnects when the api restarts.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { connectRunner, defaultHandlers, type RunnerLogger } from "@perch/runner";
import { dataDirFrom } from "../paths.ts";

const HELP = `perch runner connect <api-url> [options]

Options:
  --token <prt_…>     the connect token from the Environments page (or PERCH_RUNNER_TOKEN)
  --name <name>       how this machine shows up (default: the hostname)
  --kind local|remote local: a laptop; remote: a box you own elsewhere (default: local)
  --json              log JSON lines instead of plain lines
  -h, --help          show this help`;

export async function runRunner(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "connect") return runConnect(rest);
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(HELP);
    return sub === undefined ? 2 : 0;
  }
  console.error(`unknown runner command: ${sub}\n\n${HELP}`);
  return 2;
}

export function parseConnectArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
):
  | { kind: "help" }
  | { kind: "error"; message: string }
  | {
      kind: "connect";
      apiUrl: string;
      token: string;
      name: string;
      runnerKind: "local" | "remote";
      json: boolean;
    } {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: Record<string, { type: "string" | "boolean"; short?: string }>;
      strict: true;
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        token: { type: "string" },
        name: { type: "string" },
        kind: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  const apiUrl = positionals[0] ?? env.PERCH_API_URL;
  if (!apiUrl || !/^https?:\/\//.test(apiUrl)) {
    return { kind: "error", message: "the api URL is required (https://perch.example.com)" };
  }
  const token =
    (typeof values.token === "string" ? values.token : undefined) ?? env.PERCH_RUNNER_TOKEN;
  if (!token?.startsWith("prt_")) {
    return {
      kind: "error",
      message: "--token (or PERCH_RUNNER_TOKEN) must be a prt_… connect token",
    };
  }
  const runnerKind = typeof values.kind === "string" ? values.kind : "local";
  if (runnerKind !== "local" && runnerKind !== "remote") {
    return { kind: "error", message: `--kind must be local or remote (got ${runnerKind})` };
  }
  return {
    kind: "connect",
    apiUrl,
    token,
    name: (typeof values.name === "string" ? values.name : undefined) ?? hostname(),
    runnerKind,
    json: values.json === true,
  };
}

async function runConnect(argv: string[]): Promise<number> {
  const args = parseConnectArgs(argv);
  if (args.kind === "help") {
    console.log(HELP);
    return 0;
  }
  if (args.kind === "error") {
    console.error(`${args.message}\n\n${HELP}`);
    return 2;
  }
  const log: RunnerLogger = (level, msg, fields) => {
    const line = args.json
      ? JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })
      : `${level.padEnd(5)} ${msg}${fields ? ` ${JSON.stringify(fields)}` : ""}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
  const client = connectRunner({
    apiUrl: args.apiUrl,
    token: args.token,
    name: args.name,
    kind: args.runnerKind,
    log,
    // Projects live beside laptop mode's data, under ~/.perch/projects (or PERCH_PROJECTS_DIR).
    handlers: defaultHandlers({
      projects: {
        root: process.env.PERCH_PROJECTS_DIR ?? join(dataDirFrom(undefined), "projects"),
      },
    }),
  });
  const stop = async () => {
    log("info", "disconnecting");
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  try {
    const result = await client.registered();
    log("info", `connected to ${args.apiUrl} as ${args.name}`, { runnerId: result.runner_id });
  } catch (error) {
    log("error", error instanceof Error ? error.message : String(error));
    return 1;
  }
  // Stay up until stopped; the client reconnects on its own.
  await new Promise<void>(() => {});
  return 0;
}
