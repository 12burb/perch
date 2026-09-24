import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@perch/db";
import { eq } from "drizzle-orm";
import type { Booted } from "../src/boot.ts";
import { silentLogger } from "../src/logging.ts";
import { authenticateRunnerToken } from "../src/services/runners.ts";
import { completeSetup } from "../src/services/setup.ts";
import { createWorkspace } from "../src/services/workspaces.ts";
import type {
  ContainerSummary,
  DockerClient,
  RunnerContainerSpec,
  SelfInfo,
} from "../src/supervisor/docker.ts";
import { mountsFor, parseLimits } from "../src/supervisor/docker.ts";
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
 * everyone; reconciliation forgets dead containers and removes orphans. A workspace's container sees
 * its own directory of each volume and nothing else, and a new container's token is the only one
 * its runner has (ADR-0171). The Docker Engine is a fake here; supervisor.docker.test.ts drives the
 * real one where a daemon exists.
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
/** Where this process sees the two volumes, as the compose file mounts them into the supervisor. */
let volumes = "";
let roots = { homes: "", projects: "" };

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
  volumes = mkdtempSync(join(tmpdir(), "perch-supervisor-volumes-"));
  roots = { homes: join(volumes, "homes"), projects: join(volumes, "projects") };
  mkdirSync(roots.homes);
  mkdirSync(roots.projects);
}, 60_000);

afterAll(async () => {
  await booted.close();
  rmSync(volumes, { recursive: true, force: true });
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
    volumeRoots: roots,
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
    // Its own workspace's directory of each volume, at the paths the runner already uses.
    expect(containerA.spec.mounts).toEqual([
      { volume: "perch_runner_homes", target: "/data/homes", subpath: wsA },
      { volume: "perch_projects", target: `/data/projects/${wsA}`, subpath: wsA },
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

    // The next request brings it back, with a new token — and the sweep leaves it alone even
    // though the row still says it was last seen an hour ago: the start refreshes that, or a
    // container would be removed before its runner had registered (ADR-0165).
    await booted.db.db
      .update(schema.runners)
      .set({ lastSeenAt: new Date("2026-09-14T11:00:00Z") })
      .where(eq(schema.runners.id, a.runner.id));
    const back = await supervisor.ensure(wsA);
    expect(back.created).toBe(true);
    expect(back.runner.id).toBe(a.runner.id);
    expect(await supervisor.stopIdle()).toEqual([]);
    expect(docker.containers.has(back.containerId)).toBe(true);
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
    // One container for everyone sees everything: the whole of both volumes (single-tenant, ADR-0171).
    expect(docker.containers.get(a.containerId)?.spec.mounts).toEqual([
      { volume: "perch_runner_homes", target: "/data/homes" },
      { volume: "perch_projects", target: "/data/projects" },
    ]);
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

describe("one workspace's container, one workspace's files (ADR-0171)", () => {
  function supervise(
    docker: ReturnType<typeof fakeDocker>,
    overrides: Partial<SupervisorConfig> = {},
  ) {
    return createSupervisor({
      db: booted.db.db,
      queue: booted.queue,
      docker: docker.client,
      config: config(overrides),
      log: silentLogger(),
    });
  }

  test("a workspace's container mounts its own directory of each volume, never the whole volume and never another workspace's", async () => {
    const docker = fakeDocker();
    const supervisor = supervise(docker);
    await supervisor.reconcile();
    const a = await supervisor.ensure(wsA);
    const b = await supervisor.ensure(wsB);
    const mountsA = docker.containers.get(a.containerId)?.spec.mounts ?? [];
    const mountsB = docker.containers.get(b.containerId)?.spec.mounts ?? [];
    expect(mountsA).toEqual([
      { volume: "perch_runner_homes", target: "/data/homes", subpath: wsA },
      { volume: "perch_projects", target: `/data/projects/${wsA}`, subpath: wsA },
    ]);
    for (const mount of mountsA) {
      expect(mount.subpath).toBe(wsA);
      expect(JSON.stringify(mount)).not.toContain(wsB);
    }
    for (const mount of mountsB) expect(mount.subpath).toBe(wsB);
    // The directories exist before a container asks for them: a subpath must, and so must a bind.
    for (const ws of [wsA, wsB]) {
      expect(statSync(join(roots.homes, ws)).isDirectory()).toBe(true);
      expect(statSync(join(roots.projects, ws)).isDirectory()).toBe(true);
    }
  });

  test("a new container's token is the only one its runner has: the older ones are revoked", async () => {
    const docker = fakeDocker();
    const supervisor = supervise(docker);
    await supervisor.reconcile();
    const first = await supervisor.ensure(wsA);
    const firstToken = docker.containers.get(first.containerId)?.spec.env.PERCH_RUNNER_TOKEN ?? "";
    expect((await authenticateRunnerToken(booted.db.db, firstToken))?.id).toBe(first.runner.id);
    // The container dies; the next request starts a replacement with a token of its own.
    docker.containers.delete(first.containerId);
    const second = await supervisor.ensure(wsA);
    expect(second.created).toBe(true);
    const secondToken =
      docker.containers.get(second.containerId)?.spec.env.PERCH_RUNNER_TOKEN ?? "";
    expect(secondToken).not.toBe(firstToken);
    expect((await authenticateRunnerToken(booted.db.db, secondToken))?.id).toBe(first.runner.id);
    // Whoever read the first container's token can no longer register as this runner with it.
    expect(await authenticateRunnerToken(booted.db.db, firstToken)).toBeNull();
    const live = await booted.db.db
      .select()
      .from(schema.runnerTokens)
      .where(eq(schema.runnerTokens.runnerId, first.runner.id));
    expect(live.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  test("a member's home from before workspaces had their own is copied in once, links and modes kept", async () => {
    const ws = (
      await createWorkspace(booted.db.db, booted.bus, {
        name: "Gamma",
        slug: "gamma",
        by: { actor: { type: "user", id: adminId }, meta: { requestId: "test" } },
      })
    ).id;
    // The layout before ADR-0171: /data/homes/<user>, one home per person across every workspace.
    const legacy = join(roots.homes, adminId);
    mkdirSync(join(legacy, ".config", "tool"), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, ".config", "tool", "login.json"), '{"who":"admin"}', {
      mode: 0o600,
    });
    symlinkSync(".config/tool/login.json", join(legacy, "login-link"));
    const docker = fakeDocker();
    const supervisor = supervise(docker);
    await supervisor.reconcile();
    const first = await supervisor.ensure(ws);
    const copied = join(roots.homes, ws, adminId);
    expect(readFileSync(join(copied, ".config", "tool", "login.json"), "utf8")).toBe(
      '{"who":"admin"}',
    );
    expect(statSync(join(copied, ".config", "tool", "login.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(copied, "login-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(copied, "login-link"))).toBe(".config/tool/login.json");
    // Once: the workspace's own copy is its own from now on, whatever happens to the old one.
    writeFileSync(join(legacy, ".config", "tool", "login.json"), '{"who":"changed"}');
    writeFileSync(join(copied, "mine"), "written in the workspace");
    docker.containers.delete(first.containerId);
    await supervisor.ensure(ws);
    expect(readFileSync(join(copied, ".config", "tool", "login.json"), "utf8")).toBe(
      '{"who":"admin"}',
    );
    expect(existsSync(join(copied, "mine"))).toBe(true);
    // Only members are copied: a stranger's legacy home stays where it was.
    expect(existsSync(join(roots.homes, ws, "0190f2d0-0000-7000-8000-00000000dead"))).toBe(false);
  });

  test("a supervisor that cannot see the volumes, or a workspace id that is not one, is refused plainly", async () => {
    const docker = fakeDocker();
    const blind = supervise(docker, {
      volumeRoots: { homes: join(volumes, "nowhere"), projects: roots.projects },
    });
    await blind.reconcile();
    await expect(blind.ensure(wsA)).rejects.toThrow(/homes volume.*\/nowhere/);
    const supervisor = supervise(docker);
    await expect(supervisor.ensure("../../etc")).rejects.toThrow(/not a workspace id/);
    expect(existsSync(join(volumes, "etc"))).toBe(false);
  });

  test("a subpath where the Engine has them (API 1.45, Docker 26), a bind of the volume's directory where it does not", () => {
    const mounts = [
      { volume: "perch_runner_homes", target: "/data/homes", subpath: "ws-1" },
      { volume: "perch_projects", target: "/data/projects" },
    ];
    expect(mountsFor(mounts, "1.45", {})).toEqual([
      {
        Type: "volume",
        Source: "perch_runner_homes",
        Target: "/data/homes",
        VolumeOptions: { Subpath: "ws-1" },
      },
      { Type: "volume", Source: "perch_projects", Target: "/data/projects" },
    ]);
    expect(mountsFor(mounts, "1.54", {})[0]).toMatchObject({ VolumeOptions: { Subpath: "ws-1" } });
    expect(
      mountsFor(mounts, "1.44", {
        perch_runner_homes: "/var/lib/docker/volumes/perch_runner_homes/_data",
      }),
    ).toEqual([
      {
        Type: "bind",
        Source: "/var/lib/docker/volumes/perch_runner_homes/_data/ws-1",
        Target: "/data/homes",
      },
      { Type: "volume", Source: "perch_projects", Target: "/data/projects" },
    ]);
    // A bind with no directory to bind is not a mount of the whole volume by accident.
    expect(() => mountsFor(mounts, "1.41", {})).toThrow(/perch_runner_homes/);
  });
});
