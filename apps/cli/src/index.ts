#!/usr/bin/env bun
/**
 * The perch binary (spec §2, §8): `perch init` writes a deployment; `perch dev`, `doctor`, `backup`,
 * `restore`, `runner connect`, and `migrate` arrive with tasks 0.14 and 1.3. Argument parsing is
 * node:util's parseArgs; no dependency.
 */
import { runInit } from "./commands/init.ts";

export const packageName = "@perch/cli";

const USAGE = `perch <command> [options]

Commands:
  init      write .env, docker-compose.yml, and a Caddyfile for docker compose (team mode)
  help      show this help

Run "perch <command> --help" for the options of a command.`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return runInit(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
