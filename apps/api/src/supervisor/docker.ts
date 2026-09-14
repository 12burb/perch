/**
 * The slice of the Docker Engine API the supervisor uses (spec §3.1), behind an interface so the
 * lifecycle logic is unit-tested with a fake and the real client is dockerode (ADR-0035: never a
 * hijacked connection; the supervisor never execs interactively).
 */
import { hostname } from "node:os";
import Docker from "dockerode";

export const RUNNER_LABELS = {
  role: "dev.perch.role",
  workspace: "dev.perch.workspace",
  runner: "dev.perch.runner",
} as const;
export const RUNNER_ROLE = "runner";

export type RunnerLimits = { nanoCpus: number; memoryBytes: number; pids: number };

export type RunnerContainerSpec = {
  name: string;
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  limits: RunnerLimits;
  mounts: Array<{ volume: string; target: string }>;
  network?: string;
  /** Overrides the image entrypoint (tests run a stock image). */
  cmd?: string[];
};

export type ContainerSummary = {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
};

export type SelfInfo = {
  mounts: Array<{ volume: string; target: string }>;
  networks: string[];
};

export interface DockerClient {
  ping(): Promise<void>;
  /** Pulls the image when it is not present. */
  ensureImage(image: string): Promise<void>;
  ensureVolume(name: string): Promise<void>;
  /** Every container carrying the runner role label, running or not. */
  listRunners(): Promise<ContainerSummary[]>;
  create(spec: RunnerContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSeconds: number): Promise<void>;
  remove(id: string): Promise<void>;
  inspect(id: string): Promise<ContainerSummary | null>;
  /** The named volumes and networks of this process's own container (compose), or nothing outside Docker. */
  self(): Promise<SelfInfo>;
}

/** `cpus=2,memory=4g,pids=512` (spec §8 PERCH_RUNNER_LIMITS). */
export function parseLimits(text: string): RunnerLimits {
  const limits: RunnerLimits = { nanoCpus: 2_000_000_000, memoryBytes: 4 * 1024 ** 3, pids: 512 };
  for (const part of text.split(",")) {
    const [key, raw] = part.split("=").map((s) => s.trim());
    if (!key || raw === undefined) continue;
    if (key === "cpus") {
      const cpus = Number(raw);
      if (!Number.isFinite(cpus) || cpus <= 0)
        throw new Error(`bad cpus in PERCH_RUNNER_LIMITS: ${raw}`);
      limits.nanoCpus = Math.round(cpus * 1_000_000_000);
    } else if (key === "memory") {
      const match = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(raw);
      if (!match) throw new Error(`bad memory in PERCH_RUNNER_LIMITS: ${raw}`);
      const unit =
        { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(match[2] ?? "").toLowerCase()] ?? 1;
      limits.memoryBytes = Math.round(Number(match[1]) * unit);
    } else if (key === "pids") {
      const pids = Number(raw);
      if (!Number.isInteger(pids) || pids <= 0)
        throw new Error(`bad pids in PERCH_RUNNER_LIMITS: ${raw}`);
      limits.pids = pids;
    } else {
      throw new Error(`unknown key in PERCH_RUNNER_LIMITS: ${key}`);
    }
  }
  return limits;
}

function summarize(info: Docker.ContainerInspectInfo): ContainerSummary {
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ""),
    labels: info.Config.Labels ?? {},
    running: info.State.Running,
  };
}

export function dockerodeClient(options: { socketPath?: string } = {}): DockerClient {
  const docker = new Docker(
    options.socketPath
      ? { socketPath: options.socketPath }
      : process.env.DOCKER_HOST
        ? {}
        : { socketPath: "/var/run/docker.sock" },
  );
  return {
    async ping() {
      await docker.ping();
    },
    async ensureImage(image) {
      try {
        await docker.getImage(image).inspect();
        return;
      } catch {
        // Not present locally.
      }
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) =>
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
      );
    },
    async ensureVolume(name) {
      try {
        await docker.getVolume(name).inspect();
      } catch {
        await docker.createVolume({ Name: name, Labels: { [RUNNER_LABELS.role]: RUNNER_ROLE } });
      }
    },
    async listRunners() {
      const list = await docker.listContainers({
        all: true,
        filters: { label: [`${RUNNER_LABELS.role}=${RUNNER_ROLE}`] },
      });
      return list.map((c) => ({
        id: c.Id,
        name: (c.Names[0] ?? "").replace(/^\//, ""),
        labels: c.Labels ?? {},
        running: c.State === "running",
      }));
    },
    async create(spec) {
      const container = await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        ...(spec.cmd ? { Cmd: spec.cmd } : {}),
        Labels: spec.labels,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        HostConfig: {
          NanoCpus: spec.limits.nanoCpus,
          Memory: spec.limits.memoryBytes,
          PidsLimit: spec.limits.pids,
          RestartPolicy: { Name: "unless-stopped" },
          Mounts: spec.mounts.map((m) => ({ Type: "volume", Source: m.volume, Target: m.target })),
          ...(spec.network ? { NetworkMode: spec.network } : {}),
        },
      });
      return container.id;
    },
    async start(id) {
      await docker.getContainer(id).start();
    },
    async stop(id, timeoutSeconds) {
      try {
        await docker.getContainer(id).stop({ t: timeoutSeconds });
      } catch (error) {
        // 304: already stopped.
        if ((error as { statusCode?: number }).statusCode !== 304) throw error;
      }
    },
    async remove(id) {
      try {
        await docker.getContainer(id).remove({ force: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    },
    async inspect(id) {
      try {
        return summarize(await docker.getContainer(id).inspect());
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return null;
        throw error;
      }
    },
    async self() {
      try {
        const info = await docker.getContainer(hostname()).inspect();
        const mounts = (info.Mounts ?? [])
          .filter((m) => m.Type === "volume" && m.Name)
          .map((m) => ({ volume: m.Name ?? "", target: m.Destination }));
        const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
        return { mounts, networks };
      } catch {
        return { mounts: [], networks: [] };
      }
    },
  };
}
