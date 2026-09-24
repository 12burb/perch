#!/usr/bin/env bun
/**
 * Entrypoints (spec §8): `api` (default) serves HTTP + WS and runs the jobs worker in-process;
 * `worker` runs only the jobs worker; `supervisor` owns the Docker socket and runs the runner
 * containers (task 1.2); `backup` and `restore` take and load an instance backup and exit, which
 * is how a team instance is restored — `docker compose run --rm api restore /data/backups/<id>`
 * against an empty database (task 4.4).
 *   bun src/index.ts            # api
 *   bun src/index.ts worker
 *   bun src/index.ts supervisor
 *   bun src/index.ts backup [<dir>]
 *   bun src/index.ts restore <dir> [--force]
 */
import { resolve } from "node:path";
import { boot, shutdown } from "./boot.ts";
import {
  auditJobHandlers,
  backupJobHandlers,
  scheduleAuditRetention,
  scheduleBackups,
} from "./jobs/backups.ts";
import { repoIndexJobHandlers } from "./jobs/repo-index.ts";
import { type RunningServer, serve } from "./server.ts";
import { AUDIT_QUEUE } from "./services/audit.ts";
import { BACKUPS_QUEUE } from "./services/backups.ts";
import { REPO_INDEX_QUEUE } from "./services/repo-index.ts";
import { dockerodeClient } from "./supervisor/docker.ts";
import { createSupervisor, supervisorConfigFromEnv } from "./supervisor/supervisor.ts";

const entrypoint = process.argv[2] ?? "api";

const booted = await boot({
  app: { webDist: resolve(import.meta.dir, "..", "..", "web", "dist") },
  // Only the api owns the work a restart interrupts (setups, sessions, bot runs, the merge queue):
  // the supervisor, a separate worker, backup and restore boot beside a running api, and settling
  // its in-flight work from there would fail it under its feet (ADR-0177).
  recover: entrypoint === "api",
});

/** The HTTP server, once the api serves: stopped first on the way down (A-co-17). */
let server: RunningServer | null = null;

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
  const stop = async () => {
    await shutdown(booted, { stops: [() => supervisor.stop()] });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (entrypoint === "worker" || entrypoint === "api") {
  // The nightly backup is a cron row, put in place (or taken away) every time a worker starts.
  await scheduleBackups(booted);
  await scheduleAuditRetention(booted);
  const worker = booted.queue.worker({
    queues: ["system", "bots", REPO_INDEX_QUEUE, BACKUPS_QUEUE, AUDIT_QUEUE],
    handlers: {
      ...booted.bots.jobHandlers(),
      ...repoIndexJobHandlers(booted),
      ...backupJobHandlers(booted),
      ...auditJobHandlers(booted),
    },
  });
  worker.start();
  const stop = async () => {
    // The server stops taking requests before anything it relies on goes (A-co-17).
    await shutdown(booted, { server, stops: [() => worker.stop()] });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (entrypoint === "backup" || entrypoint === "restore") {
  // Both run to a finish and exit: nothing is served, and the process is the whole operation.
  const rest = process.argv.slice(3);
  const dir = rest.find((one) => !one.startsWith("--"));
  try {
    if (entrypoint === "backup") {
      const backup = await booted.backups.create(dir ? { dir } : {});
      console.log(`backup ${backup.id} written to ${backup.path}`);
      console.log(
        `  ${backup.manifest.database.rows} rows, ${backup.manifest.files.count} files, key ${backup.manifest.masterKey.fingerprint}`,
      );
    } else {
      if (!dir) {
        console.error("usage: restore <backup-dir> [--force]");
        await booted.close();
        process.exit(2);
      }
      const result = await booted.backups.restore(dir, { force: rest.includes("--force") });
      console.log(`restored ${result.rows} rows and ${result.files} files from ${dir}`);
      if (!result.keyMatches) {
        console.error(
          "warning: this instance's PERCH_MASTER_KEY is not the one these rows were encrypted with; credentials will not decrypt",
        );
      }
    }
    await booted.close();
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await booted.close();
    process.exit(1);
  }
}

if (entrypoint === "api") {
  server = serve(booted);
}
