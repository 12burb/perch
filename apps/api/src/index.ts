#!/usr/bin/env bun
/**
 * Entrypoints (spec §8): `api` (default) serves HTTP + WS and runs the jobs worker in-process;
 * `worker` runs only the jobs worker; `supervisor` owns the Docker socket and arrives with task 1.2.
 *   bun src/index.ts            # api
 *   bun src/index.ts worker
 *   bun src/index.ts supervisor
 */
import { resolve } from "node:path";
import { boot } from "./boot.ts";
import { serve } from "./server.ts";

const entrypoint = process.argv[2] ?? "api";

if (entrypoint === "supervisor") {
  console.error("the supervisor entrypoint arrives with task 1.2 (spec §3.1)");
  process.exit(2);
}

const booted = await boot({
  app: { webDist: resolve(import.meta.dir, "..", "..", "web", "dist") },
});

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
