import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { silentLogger } from "../src/logging.ts";
import { completeSetup } from "../src/services/setup.ts";
import { createWorkspace } from "../src/services/workspaces.ts";
import type {
  ContainerSummary,
  DockerClient,
  RunnerContainerSpec,
  SelfInfo,
} from "../src/supervisor/docker.ts";
import { parseLimits } from "../src/supervisor/docker.ts";
import {
  createSupervisor,
  requestRunner,
  SUPERVISOR_QUEUE,
  type SupervisorConfig,
} from "../src/supervisor/supervisor.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 1.2 (spec §3.1, §3.2): two workspaces get two containers with limits, labels, volumes, and a
 * connect token; a request for a workspace that already has a running container is a no-op; idle
 * runners are stopped and removed after PERCH_RUNNER_IDLE_MINUTES; shared mode runs one container for
 * everyone; reconciliation forgets dead containers and removes orphans. The Docker Engine is a fake here;
 * supervisor.docker.test.ts drives the real one where a daemon exists.
 */

type FakeContainer = ContainerSummary & { spec: RunnerContainerSpec; started: boolean };

function fakeDocker(self: SelfInfo = { mounts: [], networks: [] }) {
  const containers = new Map<string, FakeContainer>();
  const images = new Set<string>();
  const volumes = new Set<string>();
  const calls: string[] = [];
  let seq = 0;
  const client: DockerClient = {
    async ping() {
      calls.push("ping");
    },
    async ensureImage(image) {
      calls.push(`ensureImage ${image}`);
      images.add(image);
    },
    async ensureVolume(name) {
      volumes.add(name);
    },
    async listRunners() {
      return [...containers.values()].map(
        ({ spec: _spec, started: _started, ...summary }) => summary,
      );
    },
    async create(spec) {
      const id = `c${++seq}`.padEnd(12, "0");
      containers.set(id, {
        id,
        name: spec.name,
        labels: spec.labels,
        running: false,
        spec,
        started: false,
      });
      calls.push(`create ${spec.name}`);
      return id;
    },
    async start(id) {
      const c = containers.get(id);
      if (!c) throw new Error(`no container ${id}`);
      c.running = true;
      c.started = true;
      calls.push(`start ${id}`);
    },
    async stop(id, timeout) {
      const c = containers.get(id);
      if (c) c.running = false;
      calls.push(`stop ${id} t=${timeout}`);
    },
    async remove(id) {
      containers.delete(id);
      calls.push(`remove ${id}`);
    },
    async inspect(id) {
      const c = containers.get(id);
      if (!c) return null;
      const { spec: _spec, started: _started, ...summary } = c;
      return summary;
    },
    async self() {
      return self;
    },
  };
  return { client, containers, images, volumes, calls };
}

let booted: Booted;
let wsA = "";
let wsB = "";
let adminId = "";

beforeAll(async () => {
  booted = await bootTestApp({}, { setup: false });
  await completeSetup(
    { db: booted.db.db, bus: booted.bus, auth: booted.auth, publicUrl: booted.env.publicUrl },
    {
      admin: { name: "Admin", email: "admin@perch.test", password: "admin-passphrase-for-tests" },
      workspace: { name: "Alpha" },
      publicUrl: booted.env.publicUrl,
      telemetry: false,
    },
  );
  const [alpha] = await booted.db.db.select().from(schema.workspaces).limit(1);
  const [admin] = await booted.db.db.select().from(schema.users).limit(1);
  if (!alpha || !admin) throw new Error("setup incomplete");
  wsA = alpha.id;
  adminId = admin.id;
  const beta = await createWorkspace(booted.db.db, booted.bus, {
    name: "Beta",
    slug: "beta",
    by: { actor: { type: "user", id: adminId }, meta: { requestId: "test" } },
  });
  wsB = beta.id;
});

afterAll(async () => {
  await booted.close();
});

function config(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    mode: "docker",
    image: "ghcr.io/12burb/perch-runner:test",
    limits: parseLimits("cpus=1.5,memory=512m,pids=256"),
    idleMinutes: 30,
    apiUrl: "http://api:3000",
    homesVolume: undefined,
    projectsVolume: undefined,
    network: undefined,
    ...overrides,
  };
}

async function runnerRows() {
  return booted.db.db.select().from(schema.runners).where(eq(schema.runners.kind, "hosted"));
}

describe("supervisor (task 1.2)", () => {
  test("PERCH_RUNNER_LIMITS parses cpus, memory units, and pids", () => {
    expect(parseLimits("cpus=2,memory=4g,pids=512")).toEqual({
      nanoCpus: 2_000_000_000,
      memoryBytes: 4 * 1024 ** 3,
      pids: 512,
    });
    expect(parseLimits("memory=512m").memoryBytes).toBe(512 * 1024 ** 2);
    expect(parseLimits("cpus=0.5").nanoCpus).toBe(500_000_000);
    expect(() => parseLimits("cpus=lots")).toThrow(/bad cpus/);
    expect(() => parseLimits("gpus=1")).toThrow(/unknown key/);
  });

  test("two workspaces get two containers, each with limits, labels, mounts, and its own token; a repeat is a no-op", async () => {
    const docker = fakeDocker({
      mounts: [
        { volume: "perch_runner_homes", target: "/data/homes" },
        { volume: "perch_projects", target: "/data/projects" },
        { volume: "perch_pgdata", target: "/var/lib/postgresql/data" },
      ],
      networks: ["perch_default"],
    });
    const now = new Date("2026-09-14T10:00:00Z");
    const supervisor = createSupervisor({
      db: booted.db.db,
      queue: booted.queue,
      docker: docker.client,
      config: config(),
      log: silentLogger(),
      now: () => now,
    });
    const a = await supervisor.ensure(wsA);
    const b = await supervisor.ensure(wsB);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.containerId).not.toBe(b.containerId);
    expect(docker.containers.size).toBe(2);
    expect(docker.images.has("ghcr.io/12burb/perch-runner:test")).toBe(true);

    const containerA = docker.containers.get(a.containerId);
    if (!containerA) throw new Error("container A missing");
    expect(containerA.running).toBe(true);
    expect(containerA.spec.limits).toEqual({
      nanoCpus: 1_500_000_000,
      memoryBytes: 512 * 1024 ** 2,
      pids: 256,
    });
    expect(containerA.spec.labels).toEqual({
      "dev.perch.role": "runner",
      "dev.perch.workspace": wsA,
      "dev.perch.runner": a.runner.id,
    });
    expect(containerA.spec.env.PERCH_API_URL).toBe("http://api:3000");
    expect(containerA.spec.env.PERCH_RUNNER_KIND).toBe("hosted");
    expect(containerA.spec.env.PERCH_RUNNER_TOKEN).toMatch(/^prt_/);
    expect(containerA.spec.mounts).toEqual([
      { volume: "perch_runner_homes", target: "/data/homes" },
      { volume: "perch_projects", target: "/data/projects" },
    ]);
    expect(containerA.spec.network).toBe("perch_default");
    expect(docker.volumes.has("perch_runner_homes")).toBe(true);
    const containerB = docker.containers.get(b.containerId);
    expect(containerB?.spec.env.PERCH_RUNNER_TOKEN).not.toBe(
      containerA.spec.env.PERCH_RUNNER_TOKEN,
    );

    // The rows carry the container ids; the tokens are stored hashed, never in clear.
    const rows = await runnerRows();
    expect(rows.map((r) => r.containerId).sort()).toEqual([a.containerId, b.containerId].sort());
    const tokens = await booted.db.db.select().from(schema.runnerTokens);
    expect(tokens.length).toBe(2);
    expect(tokens.every((t) => !t.tokenHash.startsWith("prt_"))).toBe(true);

    // Asking again for a workspace with a running container changes nothing.
    const again = await supervisor.ensure(wsA);
    expect(again.created).toBe(false);
    expect(again.containerId).toBe(a.containerId);
    expect(docker.containers.size).toBe(2);

    // Concurrent requests for one workspace start one container.
    docker.containers.delete(a.containerId);
    const [c1, c2] = await Promise.all([supervisor.ensure(wsA), supervisor.ensure(wsA)]);
    expect(c1.containerId).toBe(c2.containerId);
    expect(docker.containers.size).toBe(2);

    // The queue delivers requests from the api process: one job, one ensure.
    await requestRunner(booted.queue, wsB);
    const worker = booted.queue.worker({
      queues: [SUPERVISOR_QUEUE],
      handlers: {
        [SUPERVISOR_QUEUE]: async (job) => {
          await supervisor.ensure(String(job.payload.workspaceId));
        },
      },
    });
    const job = await worker.tick();
    expect(job?.queue).toBe(SUPERVISOR_QUEUE);
    expect(docker.containers.size).toBe(2);
  });

  test("idle stop: a runner with no sessions past the idle limit loses its container; a busy one keeps it", async () => {
    const docker = fakeDocker();
    let now = new Date("2026-09-14T12:00:00Z");
    const supervisor = createSupervisor({
      db: booted.db.db,
      queue: booted.queue,
      docker: docker.client,
      config: config({ idleMinutes: 30 }),
      log: silentLogger(),
      now: () => now,
    });
    // Fresh rows from this supervisor: the earlier test's containers do not exist in this fake.
    await supervisor.reconcile();
    const a = await supervisor.ensure(wsA);
    const b = await supervisor.ensure(wsB);
    // The api's channel records heartbeats: A idle since noon, B busy (one session).
    await booted.db.db
      .update(schema.runners)
      .set({ idleSince: now, status: "online" })
      .where(eq(schema.runners.id, a.runner.id));
    await booted.db.db
      .update(schema.runners)
      .set({ idleSince: null, status: "online", updatedAt: now })
      .where(eq(schema.runners.id, b.runner.id));

    now = new Date("2026-09-14T12:29:00Z");
    expect(await supervisor.stopIdle()).toEqual([]);
    now = new Date("2026-09-14T12:31:00Z");
    expect(await supervisor.stopIdle()).toEqual([a.runner.id]);
    expect(docker.containers.has(a.containerId)).toBe(false);
    expect(docker.containers.has(b.containerId)).toBe(true);
    expect(docker.calls).toContain(`stop ${a.containerId} t=10`);
    const [rowA] = await booted.db.db
      .select()
      .from(schema.runners)
      .where(eq(schema.runners.id, a.runner.id));
    expect(rowA?.containerId).toBeNull();
    expect(rowA?.status).toBe("offline");

    // The next request brings it back, with a new token.
    const back = await supervisor.ensure(wsA);
    expect(back.created).toBe(true);
    expect(back.runner.id).toBe(a.runner.id);
  });

  test("shared mode runs one container for every workspace, on a runner row without a workspace", async () => {
    const docker = fakeDocker();
    const supervisor = createSupervisor({
      db: booted.db.db,
      queue: booted.queue,
      docker: docker.client,
      config: config({ mode: "shared" }),
      log: silentLogger(),
    });
    const a = await supervisor.ensure(wsA);
    const b = await supervisor.ensure(wsB);
    expect(a.containerId).toBe(b.containerId);
    expect(b.created).toBe(false);
    expect(a.runner.workspaceId).toBeNull();
    expect(a.runner.name).toBe("shared");
    expect(docker.containers.get(a.containerId)?.spec.labels["dev.perch.workspace"]).toBe("shared");
    // The registry treats a workspace-less runner as usable by every workspace (RunnerRegistry.forWorkspace).
    expect(booted.runners.forWorkspace(wsB)).toEqual([]);
  });

  test("reconcile forgets containers that are gone and removes containers no row owns", async () => {
    const docker = fakeDocker();
    const supervisor = createSupervisor({
      db: booted.db.db,
      queue: booted.queue,
      docker: docker.client,
      config: config(),
      log: silentLogger(),
    });
    await supervisor.reconcile();
    const a = await supervisor.ensure(wsA);
    // The daemon lost A's container (a host reboot), and an orphan runner container appeared.
    docker.containers.delete(a.containerId);
    const orphan = await docker.client.create({
      name: "perch-runner-orphan",
      image: "x",
      labels: {
        "dev.perch.role": "runner",
        "dev.perch.workspace": wsB,
        "dev.perch.runner": "gone",
      },
      env: {},
      limits: parseLimits(""),
      mounts: [],
    });
    const result = await supervisor.reconcile();
    expect(result.forgotten).toContain(a.runner.id);
    expect(result.removed).toEqual([orphan]);
    expect(docker.containers.has(orphan)).toBe(false);
    const [rowA] = await booted.db.db
      .select()
      .from(schema.runners)
      .where(eq(schema.runners.id, a.runner.id));
    expect(rowA?.containerId).toBeNull();
  });
});
