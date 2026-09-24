import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@perch/db";
import Docker from "dockerode";
import type { Booted } from "../src/boot.ts";
import { silentLogger } from "../src/logging.ts";
import {
  type DockerClient,
  dockerodeClient,
  parseLimits,
  RUNNER_LABELS,
} from "../src/supervisor/docker.ts";
import { createSupervisor, type SupervisorConfig } from "../src/supervisor/supervisor.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.2 against a real Docker Engine (the CI check job on ubuntu; skipped where no daemon exists):
 * the dockerode client creates a limited, labelled runner container, idle stop removes it, and
 * reconciliation cleans up. A stock image with a sleep command stands in for the runner image.
 *
 * ADR-0171 on the same Engine: the container sees its own workspace's directory of each volume and
 * nothing else — as a volume subpath, and through the bind fallback an Engine older than API 1.45
 * gets. The container writes down what it sees, into the one directory it can write.
 */

const socket = "/var/run/docker.sock";
const dockerAvailable = process.env.DOCKER_HOST !== undefined || existsSync(socket);
const image = process.env.PERCH_SPIKE_DOCKER_IMAGE ?? "alpine:3.20";
const asRoot = process.getuid?.() === 0;

let booted: Booted;

function engine(): Docker {
  return new Docker(process.env.DOCKER_HOST ? {} : { socketPath: socket });
}

/** The container lists both mount points into its own homes directory, then waits. */
const LOOK = [
  "sh",
  "-c",
  "ls -A /data/homes > /data/homes/seen-homes; ls -A /data/projects > /data/homes/seen-projects; sleep 120",
];

async function waitForFile(path: string, ms = 30_000): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.length > 0) return text;
    }
    await Bun.sleep(200);
  }
  throw new Error(`${path} never appeared`);
}

async function removeVolumes(names: Record<string, string>): Promise<void> {
  for (const name of Object.values(names)) {
    await engine()
      .getVolume(name)
      .remove()
      .catch(() => undefined);
  }
}

describe.skipIf(!dockerAvailable)("supervisor on a real Docker Engine", () => {
  beforeAll(async () => {
    booted = await bootTestApp();
  });
  afterAll(async () => {
    await booted.close();
  });

  function supervise(
    docker: DockerClient,
    config: Partial<SupervisorConfig>,
    now: () => Date = () => new Date(),
  ) {
    return createSupervisor({
      db: booted.db.db,
      queue: booted.queue,
      docker,
      config: {
        mode: "docker",
        image,
        limits: parseLimits("cpus=1,memory=256m,pids=64"),
        idleMinutes: 1,
        apiUrl: "http://127.0.0.1:1",
        homesVolume: "perch-test-homes",
        projectsVolume: "perch-test-projects",
        network: undefined,
        cmd: ["sleep", "120"],
        ...config,
      },
      log: silentLogger(),
      now,
    });
  }

  test("ensure → inspect with limits and labels → what the container sees → idle stop → reconcile", async () => {
    const docker = dockerodeClient(process.env.DOCKER_HOST ? {} : { socketPath: socket });
    await docker.ping();
    const [workspace] = await booted.db.db.select().from(schema.workspaces).limit(1);
    if (!workspace) throw new Error("no workspace");
    // The two volumes' contents are directories this test owns (local volumes bound onto them),
    // which is how the supervisor sees them in compose: mounted, so it can make a directory.
    const dir = mkdtempSync(join(tmpdir(), "perch-docker-volumes-"));
    const roots = { homes: join(dir, "homes"), projects: join(dir, "projects") };
    mkdirSync(roots.homes);
    mkdirSync(roots.projects);
    const suffix = crypto.randomUUID().slice(0, 8);
    const names = {
      homes: `perch-test-homes-${suffix}`,
      projects: `perch-test-projects-${suffix}`,
    };
    await engine().createVolume({
      Name: names.homes,
      Driver: "local",
      DriverOpts: { type: "none", o: "bind", device: roots.homes },
    });
    await engine().createVolume({
      Name: names.projects,
      Driver: "local",
      DriverOpts: { type: "none", o: "bind", device: roots.projects },
    });
    // Another workspace's files, which this container must not see.
    const other = "0190f2d0-0000-7000-8000-0000000000bb";
    mkdirSync(join(roots.homes, other, "someone"), { recursive: true });
    mkdirSync(join(roots.projects, other, "their-project"), { recursive: true });
    let now = new Date();
    const supervisor = supervise(
      docker,
      { homesVolume: names.homes, projectsVolume: names.projects, volumeRoots: roots, cmd: LOOK },
      () => now,
    );
    try {
      const result = await supervisor.ensure(workspace.id);
      try {
        const summary = await docker.inspect(result.containerId);
        expect(summary?.running).toBe(true);
        expect(summary?.labels[RUNNER_LABELS.role]).toBe("runner");
        expect(summary?.labels[RUNNER_LABELS.workspace]).toBe(workspace.id);
        const listed = await docker.listRunners();
        expect(listed.some((c) => c.id === result.containerId)).toBe(true);

        // What the container sees: its own workspace's directories, not the volumes' roots.
        const homes = await waitForFile(join(roots.homes, workspace.id, "seen-homes"));
        expect(homes).not.toContain(other);
        const projects = await waitForFile(join(roots.homes, workspace.id, "seen-projects"));
        expect(projects.trim().split("\n")).toEqual([workspace.id]);

        // Idle for two minutes: stopped and removed.
        now = new Date(now.getTime() + 2 * 60_000);
        expect(await supervisor.stopIdle()).toEqual([result.runner.id]);
        expect(await docker.inspect(result.containerId)).toBeNull();
      } finally {
        await docker.remove(result.containerId);
      }
      const after = await supervisor.reconcile();
      expect(after.removed).toEqual([]);
    } finally {
      await removeVolumes(names);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  // The fallback binds a directory under the volume's own mountpoint, which is where a plain local
  // volume keeps its files and which only root can write on the host: this runs where the test is
  // root, and the subpath lane above runs everywhere.
  test.skipIf(!asRoot)(
    "an Engine without volume subpaths (API < 1.45) gets a bind of the workspace's directory (runs as root only)",
    async () => {
      const docker = dockerodeClient({
        ...(process.env.DOCKER_HOST ? {} : { socketPath: socket }),
        apiVersion: "1.44",
      });
      const [workspace] = await booted.db.db.select().from(schema.workspaces).limit(1);
      if (!workspace) throw new Error("no workspace");
      const suffix = crypto.randomUUID().slice(0, 8);
      const names = {
        homes: `perch-test-homes-${suffix}`,
        projects: `perch-test-projects-${suffix}`,
      };
      try {
        await engine().createVolume({ Name: names.homes });
        await engine().createVolume({ Name: names.projects });
        const roots = {
          homes: (await engine().getVolume(names.homes).inspect()).Mountpoint,
          projects: (await engine().getVolume(names.projects).inspect()).Mountpoint,
        };
        const other = "0190f2d0-0000-7000-8000-0000000000cc";
        mkdirSync(join(roots.homes, other), { recursive: true });
        writeFileSync(join(roots.homes, other, "private"), "not yours");
        const supervisor = supervise(docker, {
          homesVolume: names.homes,
          projectsVolume: names.projects,
          volumeRoots: roots,
          cmd: LOOK,
        });
        const result = await supervisor.ensure(workspace.id);
        try {
          const homes = await waitForFile(join(roots.homes, workspace.id, "seen-homes"));
          expect(homes).not.toContain(other);
          const projects = await waitForFile(join(roots.homes, workspace.id, "seen-projects"));
          expect(projects.trim().split("\n")).toEqual([workspace.id]);
          const mounts = (await engine().getContainer(result.containerId).inspect()).Mounts;
          expect(mounts.map((m) => m.Type).sort()).toEqual(["bind", "bind"]);
        } finally {
          await docker.remove(result.containerId);
        }
      } finally {
        await removeVolumes(names);
      }
    },
    180_000,
  );
});

describe.skipIf(dockerAvailable)("supervisor on a real Docker Engine (no daemon here)", () => {
  test("skipped: no Docker daemon in this environment; the CI check job runs it", () => {
    expect(dockerAvailable).toBe(false);
  });
});
