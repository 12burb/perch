#!/usr/bin/env bun
/**
 * The hosted runner entrypoint (spec §3.2, task 1.1): the runner image runs this with the api URL and
 * a connect token in the environment, set by the supervisor (task 1.2). Logs are JSON lines on stdout.
 *
 *   PERCH_API_URL            the api's public URL (required)
 *   PERCH_RUNNER_TOKEN       the connect token, prt_… (required; never logged)
 *   PERCH_RUNNER_NAME        shown on the Environments page (default: the hostname)
 *   PERCH_RUNNER_KIND        hosted | local | remote (default: hosted)
 *   PERCH_RUNNER_OWNER_USER  local and remote runners: the owner's user id
 *   PERCH_PROJECTS_DIR       where projects live (default: /data/projects)
 */
import { hostname } from "node:os";
import type { RunnerInfo } from "@perch/events";
import { connectRunner, type RunnerLogger } from "./client.ts";
import { projectsRoot } from "./projects.ts";

const log: RunnerLogger = (level, msg, fields) => {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    name: "perch-runner",
    msg,
    ...fields,
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};

export function runnerEnv(env: Record<string, string | undefined> = process.env) {
  const apiUrl = env.PERCH_API_URL;
  const token = env.PERCH_RUNNER_TOKEN;
  if (!apiUrl || !token) {
    throw new Error("PERCH_API_URL and PERCH_RUNNER_TOKEN are required");
  }
  const kind = env.PERCH_RUNNER_KIND ?? "hosted";
  if (!isRunnerKind(kind)) {
    throw new Error(`PERCH_RUNNER_KIND must be hosted, local, or remote (got ${kind})`);
  }
  return {
    apiUrl,
    token,
    name: env.PERCH_RUNNER_NAME ?? hostname(),
    kind,
    ownerUserId: env.PERCH_RUNNER_OWNER_USER,
  };
}

const RUNNER_KINDS: readonly RunnerInfo["kind"][] = ["hosted", "local", "remote"];
function isRunnerKind(value: string): value is RunnerInfo["kind"] {
  return (RUNNER_KINDS as readonly string[]).includes(value);
}

if (import.meta.main) {
  let config: ReturnType<typeof runnerEnv>;
  try {
    config = runnerEnv();
  } catch (error) {
    log("error", error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const client = connectRunner({
    ...config,
    log,
    handlerOptions: { projects: { root: projectsRoot() } },
  });
  const stop = async () => {
    log("info", "stopping");
    await client.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  try {
    await client.registered();
  } catch (error) {
    log("error", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
