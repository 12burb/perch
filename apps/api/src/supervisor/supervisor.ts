/**
 * The supervisor (spec §3.1, §3.2, task 1.2): the one process that owns the Docker socket. It starts one
 * runner container per workspace on demand (a `supervisor.ensure` job the api enqueues), or one shared
 * container for the whole instance (PERCH_RUNNER_MODE=shared), with the CPU, memory, and pid limits of
 * PERCH_RUNNER_LIMITS, the homes and projects volumes, and a fresh connect token in the environment;
 * stops and removes containers whose runner has reported no sessions for PERCH_RUNNER_IDLE_MINUTES; and
 * reconciles rows against containers at start. ADR-0067.
 */
import type { Db, Runner } from "@perch/db";
import { schema } from "@perch/db";
import type { Queue, Worker } from "@perch/jobs";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { findRunnerById, insertRunner, updateRunner } from "../repos/runners.ts";
import { mintRunnerToken } from "../services/runners.ts";
import {
  type DockerClient,
  parseLimits,
  RUNNER_LABELS,
  RUNNER_ROLE,
  type RunnerLimits,
} from "./docker.ts";
import { SUPERVISOR_BACKUP_QUEUE, SUPERVISOR_QUEUE } from "./queue.ts";
import { backupVolumes } from "./volumes.ts";

export {
  requestRunner,
  requestVolumeBackup,
  SUPERVISOR_BACKUP_QUEUE,
  SUPERVISOR_QUEUE,
} from "./queue.ts";

const { runners } = schema;

export const HOMES_TARGET = "/data/homes";
export const PROJECTS_TARGET = "/data/projects";

export type SupervisorConfig = {
  mode: "docker" | "shared";
  image: string;
  limits: RunnerLimits;
  idleMinutes: number;
  /** The URL runner containers reach the api at (http://api:3000 in compose). */
  apiUrl: string;
  homesVolume: string | undefined;
  projectsVolume: string | undefined;
  network: string | undefined;
  /** Overrides the image entrypoint (the Docker test runs a stock image). */
  cmd?: string[];
  /** How often idle containers are looked for. */
  tickMs?: number;
};

export type SupervisorDeps = {
  db: Db;
  queue: Queue;
  docker: DockerClient;
  config: SupervisorConfig;
  log: Logger;
  now?: () => Date;
};

export type EnsureResult = { runner: Runner; containerId: string; created: boolean };

export function supervisorConfigFromEnv(env: {
  runner: {
    mode: "docker" | "shared" | "inprocess";
    image: string;
    limits: string;
    idleMinutes: number;
    apiUrl: string | undefined;
    homesVolume: string | undefined;
    projectsVolume: string | undefined;
    network: string | undefined;
  };
  publicUrl: string;
}): SupervisorConfig {
  return {
    mode: env.runner.mode === "shared" ? "shared" : "docker",
    image: env.runner.image,
    limits: parseLimits(env.runner.limits),
    idleMinutes: env.runner.idleMinutes,
    apiUrl: env.runner.apiUrl ?? env.publicUrl,
    homesVolume: env.runner.homesVolume,
    projectsVolume: env.runner.projectsVolume,
    network: env.runner.network,
  };
}

export function createSupervisor(deps: SupervisorDeps) {
  const { db, docker, config, log } = deps;
  const now = deps.now ?? (() => new Date());
  let worker: Worker | null = null;
  let ticker: Timer | null = null;
  let volumes: { homes: string; projects: string; network: string | undefined } | null = null;
  const inflight = new Map<string, Promise<EnsureResult>>();

  /** Volume and network names: from the environment, else mirrored from this container's own mounts. */
  async function placement() {
    if (volumes) return volumes;
    const self = await docker.self();
    const byTarget = (target: string) => self.mounts.find((m) => m.target === target)?.volume;
    volumes = {
      homes: config.homesVolume ?? byTarget(HOMES_TARGET) ?? "perch_runner_homes",
      projects: config.projectsVolume ?? byTarget(PROJECTS_TARGET) ?? "perch_projects",
      network: config.network ?? self.networks[0],
    };
    return volumes;
  }

  async function findHostedRunner(workspaceId: string | null): Promise<Runner | null> {
    const [row] = await db
      .select()
      .from(runners)
      .where(
        and(
          eq(runners.kind, "hosted"),
          workspaceId === null ? isNull(runners.workspaceId) : eq(runners.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function ensureNow(requested: string | null): Promise<EnsureResult> {
    const workspaceId = config.mode === "shared" ? null : requested;
    const scope = workspaceId ?? "shared";
    let runner =
      (await findHostedRunner(workspaceId)) ??
      (await insertRunner(db, {
        workspaceId,
        kind: "hosted",
        name: workspaceId ? "hosted" : "shared",
      }));
    if (runner.containerId) {
      const existing = await docker.inspect(runner.containerId);
      if (existing?.running) return { runner, containerId: runner.containerId, created: false };
      if (existing) await docker.remove(existing.id);
      await updateRunner(db, runner.id, { containerId: null, status: "offline" });
    }
    const place = await placement();
    const { token } = await mintRunnerToken(db, runner.id);
    await docker.ensureImage(config.image);
    await docker.ensureVolume(place.homes);
    await docker.ensureVolume(place.projects);
    const containerId = await docker.create({
      name: `perch-runner-${runner.id.slice(0, 8)}`,
      image: config.image,
      labels: {
        [RUNNER_LABELS.role]: RUNNER_ROLE,
        [RUNNER_LABELS.workspace]: scope,
        [RUNNER_LABELS.runner]: runner.id,
      },
      env: {
        PERCH_API_URL: config.apiUrl,
        PERCH_RUNNER_TOKEN: token,
        PERCH_RUNNER_NAME: runner.name,
        PERCH_RUNNER_KIND: "hosted",
      },
      limits: config.limits,
      mounts: [
        { volume: place.homes, target: HOMES_TARGET },
        { volume: place.projects, target: PROJECTS_TARGET },
      ],
      network: place.network,
      cmd: config.cmd,
    });
    await docker.start(containerId);
    // last_seen_at is refreshed with the container: the idle sweep treats an offline runner not
    // seen for idleMinutes as dead, and a runner that was offline for an hour before this start
    // would otherwise lose its brand-new container before it had registered (ADR-0165).
    await updateRunner(db, runner.id, { containerId, idleSince: null, lastSeenAt: new Date() });
    runner = (await findRunnerById(db, runner.id)) ?? runner;
    log.info(
      { runner: runner.id, scope, container: containerId.slice(0, 12) },
      "runner container started",
    );
    return { runner, containerId, created: true };
  }

  /** One container per scope at a time, whatever the number of concurrent requests. */
  function ensure(workspaceId: string | null): Promise<EnsureResult> {
    const key = config.mode === "shared" ? "shared" : (workspaceId ?? "shared");
    const running = inflight.get(key);
    if (running) return running;
    const task = ensureNow(workspaceId).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  /**
   * Stops and removes containers whose runner has been idle past the limit, and containers whose
   * runner has been offline (no heartbeat, or never registered) for as long; returns the runner ids.
   */
  async function stopIdle(): Promise<string[]> {
    const cutoff = new Date(now().getTime() - config.idleMinutes * 60_000);
    const dead = and(
      eq(runners.status, "offline"),
      or(
        lt(runners.lastSeenAt, cutoff),
        and(isNull(runners.lastSeenAt), lt(runners.updatedAt, cutoff)),
      ),
    );
    const rows = await db
      .select()
      .from(runners)
      .where(
        and(
          eq(runners.kind, "hosted"),
          sql`${runners.containerId} is not null`,
          or(lt(runners.idleSince, cutoff), dead),
        ),
      );
    const stopped: string[] = [];
    for (const row of rows) {
      if (!row.containerId) continue;
      await docker.stop(row.containerId, 10);
      await docker.remove(row.containerId);
      await updateRunner(db, row.id, { containerId: null, status: "offline", idleSince: null });
      log.info({ runner: row.id, idleSince: row.idleSince }, "idle runner container stopped");
      stopped.push(row.id);
    }
    return stopped;
  }

  /** Rows against containers: forget containers that are gone, remove containers no row owns. */
  async function reconcile(): Promise<{ removed: string[]; forgotten: string[] }> {
    const containers = await docker.listRunners();
    const rows = await db.select().from(runners).where(eq(runners.kind, "hosted"));
    const owned = new Set(rows.map((r) => r.containerId).filter((id): id is string => id !== null));
    const removed: string[] = [];
    for (const container of containers) {
      if (owned.has(container.id)) continue;
      await docker.remove(container.id);
      removed.push(container.id);
    }
    const alive = new Set(containers.map((c) => c.id));
    const forgotten: string[] = [];
    for (const row of rows) {
      if (row.containerId && !alive.has(row.containerId)) {
        await updateRunner(db, row.id, { containerId: null, status: "offline", idleSince: null });
        forgotten.push(row.id);
      }
    }
    if (removed.length || forgotten.length)
      log.info({ removed, forgotten }, "runner containers reconciled");
    return { removed, forgotten };
  }

  return {
    ensure,
    stopIdle,
    reconcile,
    async start(): Promise<void> {
      await docker.ping();
      await reconcile();
      worker = deps.queue.worker({
        queues: [SUPERVISOR_QUEUE, SUPERVISOR_BACKUP_QUEUE],
        handlers: {
          [SUPERVISOR_QUEUE]: async (job) => {
            const workspaceId = job.payload.workspaceId;
            await ensure(typeof workspaceId === "string" ? workspaceId : null);
          },
          [SUPERVISOR_BACKUP_QUEUE]: async (job) => {
            const dir = job.payload.dir;
            if (typeof dir !== "string") return;
            const result = await backupVolumes(dir, log);
            log.info({ dir, ...result }, "added the project volumes to a backup");
          },
        },
        onError: (error, job) => log.error({ err: error, job: job.id }, "supervisor job failed"),
      });
      worker.start();
      ticker = setInterval(() => {
        stopIdle().catch((error: unknown) => log.error({ err: error }, "idle stop failed"));
      }, config.tickMs ?? 60_000);
      log.info(
        { mode: config.mode, image: config.image, idleMinutes: config.idleMinutes },
        "supervisor started",
      );
    },
    async stop(): Promise<void> {
      if (ticker) clearInterval(ticker);
      ticker = null;
      await worker?.stop();
      worker = null;
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
