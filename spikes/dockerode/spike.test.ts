import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import Docker from "dockerode";

/**
 * Spike 0.4.7 — dockerode from Bun (spec §9.3).
 * Pass: the supervisor creates, limits, execs into, and removes a runner container from a Bun process.
 * Needs a Docker daemon: runs on the GitHub Actions ubuntu runner (the `check` job of ci.yml and
 * spikes.yml); skips elsewhere. Outcome recorded in DECISIONS.md (ADR-0035). Fallback: supervisor on Node
 * LTS in its own image.
 */

const socket = process.env.DOCKER_HOST ? undefined : "/var/run/docker.sock";
const dockerAvailable =
  process.env.DOCKER_HOST !== undefined || (socket !== undefined && existsSync(socket));
const image = process.env.PERCH_SPIKE_DOCKER_IMAGE ?? "alpine:3.20";

async function pull(docker: Docker): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
  );
}

describe.skipIf(!dockerAvailable)("spike 0.4.7 dockerode from Bun", () => {
  test("create with limits → start → exec → stop → remove", async () => {
    const docker = new Docker(socket ? { socketPath: socket } : {});
    const version = await docker.version();
    expect(version.ApiVersion).toBeTruthy();
    await pull(docker);

    const container = await docker.createContainer({
      Image: image,
      Cmd: ["sleep", "60"],
      Labels: { "dev.perch.spike": "dockerode", "dev.perch.workspace": "spike" },
      HostConfig: {
        NanoCpus: 2_000_000_000,
        Memory: 4 * 1024 * 1024 * 1024,
        PidsLimit: 512,
        AutoRemove: false,
      },
    });
    try {
      await container.start();
      const inspect = await container.inspect();
      expect(inspect.State.Running).toBe(true);
      expect(inspect.HostConfig.NanoCpus).toBe(2_000_000_000);
      expect(inspect.HostConfig.PidsLimit).toBe(512);

      const exec = await container.exec({
        Cmd: ["sh", "-c", "echo runner-ready && id -u"],
        AttachStdout: true,
        AttachStderr: true,
      });
      // No hijack: a hijacked exec asks the daemon for `101 Switching Protocols` and raw TCP afterwards,
      // which Bun's node:http client hands back as an ordinary (failed) response. One-shot execs need no
      // stdin; PTYs go through the runner protocol (spec §7.6), never through the Docker socket.
      const stream = await exec.start({ hijack: false, stdin: false });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on("data", (c: Buffer) => chunks.push(c));
      docker.modem.demuxStream(stream, stdout, stderr);
      await new Promise<void>((resolve, reject) => {
        stream.on("end", () => resolve());
        stream.on("error", reject);
      });
      const out = Buffer.concat(chunks).toString("utf8");
      expect(out).toContain("runner-ready");
      const result = await exec.inspect();
      expect(result.ExitCode).toBe(0);

      await container.stop({ t: 1 });
    } finally {
      await container.remove({ force: true });
    }
    const gone = await docker.listContainers({
      all: true,
      filters: { label: ["dev.perch.spike=dockerode"] },
    });
    expect(gone).toEqual([]);
  }, 180_000);
});

describe.skipIf(dockerAvailable)("spike 0.4.7 dockerode from Bun (no daemon here)", () => {
  test("skipped: no Docker daemon in this environment; the CI check job on ubuntu runs it", () => {
    expect(dockerAvailable).toBe(false);
  });
});
