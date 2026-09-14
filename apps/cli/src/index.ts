#!/usr/bin/env bun
/**
 * The perch binary (spec §2, §8): `init` writes a deployment; `dev` runs laptop mode; `doctor`,
 * `backup`, `restore` look after it. `runner connect` (1.3) and `migrate --to-compose` come later.
 * Argument parsing is node:util's parseArgs; no dependency.
 */
import { runBackup, runRestore } from "./commands/backup.ts";
import { runDev } from "./commands/dev.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";

export const packageName = "@perch/cli";

const USAGE = `perch <command> [options]

Commands:
  dev       run api + web + the in-process runner on PGlite (laptop mode)
  doctor    check this machine and the laptop-mode data directory
  backup    write a backup directory of the laptop-mode data (stop perch dev first)
  restore   restore a backup directory (stop perch dev first)
  init      write .env, docker-compose.yml, and a Caddyfile for docker compose (team mode)
  help      show this help

Run "perch <command> --help" for the options of a command.`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "dev":
      return runDev(rest);
    case "doctor":
      return runDoctor(rest);
    case "backup":
      return runBackup(rest);
    case "restore":
      return runRestore(rest);
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
