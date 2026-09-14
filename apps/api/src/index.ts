#!/usr/bin/env bun
/**
 * Entrypoints (spec §8): `api` (default) serves HTTP + WS and runs the jobs worker in-process;
 * `worker` runs only the jobs worker; `supervisor` owns the Docker socket and runs the runner
 * containers (task 1.2).
 *   bun src/index.ts            # api
 *   bun src/index.ts worker
 *   bun src/index.ts supervisor
 */
import { resolve } from "node:path";
import { boot } from "./boot.ts";
import { serve } from "./server.ts";
import { dockerodeClient } from "./supervisor/docker.ts";
import { createSupervisor, supervisorConfigFromEnv } from "./supervisor/supervisor.ts";

const entrypoint = process.argv[2] ?? "api";

const booted = await boot({
  app: { webDist: resolve(import.meta.dir, "..", "..", "web", "dist") },
});

if (entrypoint === "supervisor") {
  if (booted.env.runner.mode === "inprocess") {
    booted.log.error("PERCH_RUNNER_MODE=inprocess has no supervisor; set docker or shared");
    process.exit(2);
  }
  const supervisor = createSupervisor({
    db: booted.db.db,
    queue: booted.queue,
    docker: dockerodeClient(),
    config: supervisorConfigFromEnv(booted.env),
    log: booted.log.child({ role: "supervisor" }),
  });
  await supervisor.start();
  const shutdown = async () => {
    await supervisor.stop();
    await booted.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (entrypoint === "worker" || entrypoint === "api") {
  const worker = booted.queue.worker({ queues: ["system"], handlers: {} });
  worker.start();
  const shutdown = async () => {
    await worker.stop();
    await booted.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (entrypoint === "api") {
  serve(booted);
}
