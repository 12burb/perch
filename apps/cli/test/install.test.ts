import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256 } from "../src/upgrade.ts";

/**
 * `install.sh` (task 4.3): the `curl | sh` a stranger runs, against a stand-in release server on
 * this machine rather than GitHub.
 *
 * The installer is POSIX sh so that it runs wherever `curl` does, which also means nothing
 * typechecks it — so the test runs the real script, and the case that matters is the tampered one:
 * a binary whose checksum does not match what the release published installs nothing at all.
 */

const root = resolve(import.meta.dir, "..", "..", "..");
const script = join(root, "install.sh");
const platform = process.platform === "darwin" ? "darwin" : "linux";
const cpu = process.arch === "arm64" ? "arm64" : "x64";
const asset = `perch-${platform}-${cpu}`;

const servers: { stop: (closeActiveConnections?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

function serve(tag: string, files: Record<string, string>) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/releases/latest") return Response.json({ tag_name: tag });
      const name = url.pathname.replace(`/download/${tag}/`, "");
      const body = files[name];
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return { releases: `${base}/releases`, downloads: `${base}/download` };
}

/**
 * Spawned rather than spawnSync'd: the stand-in release server answers on this process's event
 * loop, and a synchronous wait would leave `curl` talking to something that cannot reply.
 */
async function install(env: Record<string, string>) {
  const proc = Bun.spawn(["sh", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}` };
}

describe.skipIf(process.platform === "win32")("install.sh (task 4.3)", () => {
  test("installs the newest release, checksum checked, and says where it put it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-install-"));
    const binary = "#!/bin/sh\necho perch 0.3.0\n";
    const where = serve("v0.3.0", {
      [asset]: binary,
      SHA256SUMS: `${sha256(new TextEncoder().encode(binary))}  ${asset}\n`,
    });

    const run = await install({
      PERCH_INSTALL_DIR: dir,
      PERCH_RELEASES_API: where.releases,
      PERCH_DOWNLOAD_BASE: where.downloads,
    });

    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain(`installed v0.3.0 to ${dir}/perch`);
    expect(readFileSync(join(dir, "perch"), "utf8")).toBe(binary);
    // It has to be runnable without a chmod from whoever downloaded it.
    expect(statSync(join(dir, "perch")).mode & 0o111).toBeGreaterThan(0);
    // And it really runs.
    const ran = Bun.spawnSync([join(dir, "perch")], { stdout: "pipe" });
    expect(ran.stdout.toString().trim()).toBe("perch 0.3.0");
  });

  test("a tampered binary installs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-install-"));
    const where = serve("v0.3.0", {
      [asset]: "not what the release published",
      SHA256SUMS: `${sha256(new TextEncoder().encode("the honest perch"))}  ${asset}\n`,
    });

    const run = await install({
      PERCH_INSTALL_DIR: dir,
      PERCH_RELEASES_API: where.releases,
      PERCH_DOWNLOAD_BASE: where.downloads,
    });

    expect(run.code).not.toBe(0);
    expect(run.out).toContain("does not match the checksum v0.3.0 published");
    expect(existsSync(join(dir, "perch"))).toBe(false);
  });

  test("PERCH_VERSION takes a named release, and PERCH_REQUIRE_SIGNATURE refuses an unsigned one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-install-"));
    const binary = "#!/bin/sh\necho perch 0.2.0\n";
    // No /releases/latest is served at all: the named version must not need it.
    const where = serve("v0.2.0", {
      [asset]: binary,
      SHA256SUMS: `${sha256(new TextEncoder().encode(binary))}  ${asset}\n`,
    });
    const env = {
      PERCH_INSTALL_DIR: dir,
      PERCH_VERSION: "v0.2.0",
      PERCH_DOWNLOAD_BASE: where.downloads,
      PERCH_RELEASES_API: "http://127.0.0.1:1/releases",
    };

    const strict = await install({ ...env, PERCH_REQUIRE_SIGNATURE: "1" });
    expect(strict.code).not.toBe(0);
    expect(strict.out).toContain("nothing was installed");
    expect(existsSync(join(dir, "perch"))).toBe(false);

    const run = await install(env);
    expect(run.code, run.out).toBe(0);
    expect(readFileSync(join(dir, "perch"), "utf8")).toBe(binary);
  });
});
