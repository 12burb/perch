import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { schema } from "@perch/db";
import type { Booted } from "../src/boot.ts";
import { silentLogger } from "../src/logging.ts";
import { dockerodeClient, parseLimits, RUNNER_LABELS } from "../src/supervisor/docker.ts";
import { createSupervisor } from "../src/supervisor/supervisor.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.2 against a real Docker Engine (the CI check job on ubuntu; skipped where no daemon exists):
 * the dockerode client creates a limited, labelled runner container, idle stop removes it, and
 * reconciliation cleans up. A stock image with a sleep command stands in for the runner image.
 */

const socket = "/var/run/docker.sock";
const dockerAvailable = process.env.DOCKER_HOST !== undefined || existsSync(socket);
const image = process.env.PERCH_SPIKE_DOCKER_IMAGE ?? "alpine:3.20";

let booted: Booted;

describe.skipIf(!dockerAvailable)("supervisor on a real Docker Engine", () => {
  beforeAll(async () => {
    booted = await bootTestApp();
  });
  afterAll(async () => {
    await booted.close();
  });

  test("ensure → inspect with limits and labels → idle stop → reconcile", async () => {
    const docker = dockerodeClient(process.env.DOCKER_HOST ? {} : { socketPath: socket });
    await docker.ping();
    const [workspace] = await booted.db.db.select().from(schema.workspaces).limit(1);
    if (!workspace) throw new Error("no workspace");
    let now = new Date();
    const supervisor = createSupervisor({
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
      },
      log: silentLogger(),
      now: () => now,
    });
    const result = await supervisor.ensure(workspace.id);
    try {
      const summary = await docker.inspect(result.containerId);
      expect(summary?.running).toBe(true);
      expect(summary?.labels[RUNNER_LABELS.role]).toBe("runner");
      expect(summary?.labels[RUNNER_LABELS.workspace]).toBe(workspace.id);
      const listed = await docker.listRunners();
      expect(listed.some((c) => c.id === result.containerId)).toBe(true);

      // Idle for two minutes: stopped and removed.
      now = new Date(now.getTime() + 2 * 60_000);
      expect(await supervisor.stopIdle()).toEqual([result.runner.id]);
      expect(await docker.inspect(result.containerId)).toBeNull();
    } finally {
      await docker.remove(result.containerId);
    }
    const after = await supervisor.reconcile();
    expect(after.removed).toEqual([]);
  }, 180_000);
});

describe.skipIf(dockerAvailable)("supervisor on a real Docker Engine (no daemon here)", () => {
  test("skipped: no Docker daemon in this environment; the CI check job runs it", () => {
    expect(dockerAvailable).toBe(false);
  });
});
