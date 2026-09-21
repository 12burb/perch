import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetFor,
  checksumsFrom,
  isDownloadedBinary,
  repoFrom,
  sha256,
  UpgradeError,
  upgrade,
} from "../src/upgrade.ts";

/**
 * `perch upgrade` (task 4.3): a stand-in release server on this machine, and a real in-place
 * upgrade against it.
 *
 * The acceptance worth holding on to is the tampered one: an asset whose checksum does not match
 * what the release published installs nothing at all, and the binary that was there still runs.
 */

type ReleaseFiles = Record<string, string>;

function releaseServer(tag: string, files: ReleaseFiles) {
  const server = Bun.serve({
    port: 0,
    // The download URLs are built from the request's own origin, which is what GitHub's release
    // answer carries too — and saves the handler asking the server it is part of for its port.
    fetch(request): Response {
      const url = new URL(request.url);
      if (url.pathname === "/releases/latest") {
        return Response.json({
          tag_name: tag,
          assets: Object.keys(files).map((name) => ({
            name,
            browser_download_url: `${url.origin}/download/${name}`,
          })),
        });
      }
      const name = url.pathname.replace("/download/", "");
      const body = files[name];
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
    },
  });
  return { server, releases: `http://127.0.0.1:${server.port}/releases` };
}

function sumsFor(files: ReleaseFiles): string {
  return `${Object.entries(files)
    .filter(([name]) => name.startsWith("perch-"))
    .map(([name, body]) => `${sha256(new TextEncoder().encode(body))}  ${name}`)
    .join("\n")}\n`;
}

/** A cosign that says yes, or one that says no; enough to prove which way the branch goes. */
function stubCosign(dir: string, exitCode: number): string {
  const path = join(dir, "cosign");
  writeFileSync(
    path,
    `#!/bin/sh\n[ ${exitCode} -eq 0 ] || echo "no signature here" >&2\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const servers: { stop: (closeActiveConnections?: boolean) => void }[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

function serve(tag: string, files: ReleaseFiles) {
  const made = releaseServer(tag, files);
  servers.push(made.server);
  return made.releases;
}

describe("the asset a machine wants (task 4.3)", () => {
  test("is named the way the release names it", () => {
    expect(assetFor("linux", "x64")).toBe("perch-linux-x64");
    expect(assetFor("linux", "aarch64")).toBe("perch-linux-arm64");
    expect(assetFor("darwin", "arm64")).toBe("perch-darwin-arm64");
    expect(assetFor("win32", "x64")).toBe("perch-windows-x64.exe");
    expect(() => assetFor("win32", "arm64")).toThrow(UpgradeError);
    expect(() => assetFor("plan9", "x64")).toThrow("there is no Perch binary for plan9");
  });

  test("the checksum file is read the way sha256sum writes it", () => {
    const sums = checksumsFrom(
      `${"a".repeat(64)}  perch-linux-x64\n${"b".repeat(64)} *perch-windows-x64.exe\n\n# a comment\n`,
    );
    expect(sums["perch-linux-x64"]).toBe("a".repeat(64));
    expect(sums["perch-windows-x64.exe"]).toBe("b".repeat(64));
    expect(Object.keys(sums)).toHaveLength(2);
  });

  test("the repository the signature must name comes from the releases URL", () => {
    expect(repoFrom("https://api.github.com/repos/12burb/perch/releases")).toBe("12burb/perch");
    expect(repoFrom("http://127.0.0.1:1/releases")).toBe("12burb/perch");
  });
});

describe("upgrading in place (task 4.3)", () => {
  test("downloads the release, checks it, and replaces the running binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
    const target = join(dir, "perch");
    writeFileSync(target, "the old perch");
    const files: ReleaseFiles = { "perch-linux-x64": "the new perch" };
    files.SHA256SUMS = sumsFor(files);
    const lines: string[] = [];

    const result = await upgrade({
      target,
      platform: "linux",
      arch: "x64",
      version: "v0.1.0",
      releases: serve("v0.2.0", files),
      log: (line) => lines.push(line),
    });

    expect(result).toMatchObject({ from: "v0.1.0", to: "v0.2.0", already: false, path: target });
    expect(readFileSync(target, "utf8")).toBe("the new perch");
    expect(lines.join("\n")).toContain("perch is now v0.2.0");
    // Nothing is left lying around beside it.
    expect(readdirSync(dir)).toEqual(["perch"]);
  });

  test("from the npm package or a checkout, it refuses rather than replace Bun itself", async () => {
    // This test process is Bun, which is exactly the case: no target given, no binary replaced.
    expect(isDownloadedBinary()).toBe(false);
    expect(isDownloadedBinary("/usr/local/bin/perch")).toBe(true);
    expect(isDownloadedBinary("C:\\Users\\me\\perch.exe")).toBe(true);
    expect(isDownloadedBinary("/home/me/.bun/bin/bun")).toBe(false);
    await expect(
      upgrade({ fetch: () => Promise.reject(new Error("never asked")) }),
    ).rejects.toThrow(/replaces a downloaded perch binary/);
  });

  test("a tampered asset installs nothing, and the binary that was there still is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
    const target = join(dir, "perch");
    writeFileSync(target, "the old perch");
    // The checksums are for one thing; the download is another.
    const files: ReleaseFiles = { "perch-linux-x64": "the honest perch" };
    files.SHA256SUMS = sumsFor(files);
    files["perch-linux-x64"] = "something else entirely";

    await expect(
      upgrade({
        target,
        platform: "linux",
        arch: "x64",
        version: "v0.1.0",
        releases: serve("v0.2.0", files),
      }),
    ).rejects.toThrow("does not match the checksum v0.2.0 published for it; nothing was installed");

    expect(readFileSync(target, "utf8")).toBe("the old perch");
    expect(readdirSync(dir)).toEqual(["perch"]);
  });

  test("a release with no SHA256SUMS is refused before anything is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
    const target = join(dir, "perch");
    writeFileSync(target, "the old perch");

    await expect(
      upgrade({
        target,
        platform: "linux",
        arch: "x64",
        version: "v0.1.0",
        releases: serve("v0.2.0", { "perch-linux-x64": "the new perch" }),
      }),
    ).rejects.toThrow("has no SHA256SUMS");
    expect(readFileSync(target, "utf8")).toBe("the old perch");
  });

  test("the version already installed is left alone unless it is forced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
    const target = join(dir, "perch");
    writeFileSync(target, "the old perch");
    const files: ReleaseFiles = { "perch-linux-x64": "the new perch" };
    files.SHA256SUMS = sumsFor(files);
    const releases = serve("v0.2.0", files);
    const options = {
      target,
      platform: "linux",
      arch: "x64",
      // `0.2.0` and `v0.2.0` are the same version said two ways.
      version: "0.2.0",
      releases,
    };

    expect(await upgrade(options)).toMatchObject({ already: true });
    expect(readFileSync(target, "utf8")).toBe("the old perch");

    expect(await upgrade({ ...options, force: true })).toMatchObject({ already: false });
    expect(readFileSync(target, "utf8")).toBe("the new perch");
  });
});

describe.skipIf(process.platform === "win32")("the signature over the checksums (task 4.3)", () => {
  test("a release the signature does not cover installs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
    const target = join(dir, "perch");
    writeFileSync(target, "the old perch");
    const files: ReleaseFiles = { "perch-linux-x64": "the new perch" };
    files.SHA256SUMS = sumsFor(files);
    files["SHA256SUMS.sig"] = "MEUCIQ...";
    files["SHA256SUMS.pem"] = "-----BEGIN CERTIFICATE-----\n";

    await expect(
      upgrade({
        target,
        platform: "linux",
        arch: "x64",
        version: "v0.1.0",
        releases: serve("v0.2.0", files),
        cosign: stubCosign(dir, 1),
      }),
    ).rejects.toThrow("is not 12burb/perch's release workflow; nothing was installed");
    expect(readFileSync(target, "utf8")).toBe("the old perch");
  });

  test("a signed release says so, and the binary is replaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
    const target = join(dir, "perch");
    writeFileSync(target, "the old perch");
    const files: ReleaseFiles = { "perch-linux-x64": "the new perch" };
    files.SHA256SUMS = sumsFor(files);
    files["SHA256SUMS.sig"] = "MEUCIQ...";
    files["SHA256SUMS.pem"] = "-----BEGIN CERTIFICATE-----\n";
    const lines: string[] = [];

    const result = await upgrade({
      target,
      platform: "linux",
      arch: "x64",
      version: "v0.1.0",
      releases: serve("v0.2.0", files),
      cosign: stubCosign(dir, 0),
      requireSignature: true,
      log: (line) => lines.push(line),
    });

    expect(result.signature).toBe("verified");
    expect(lines.join("\n")).toContain("signed by the release workflow");
    expect(readFileSync(target, "utf8")).toBe("the new perch");
  });

  test("--require-signature refuses a release that published none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-upgrade-"));
    const target = join(dir, "perch");
    writeFileSync(target, "the old perch");
    const files: ReleaseFiles = { "perch-linux-x64": "the new perch" };
    files.SHA256SUMS = sumsFor(files);

    await expect(
      upgrade({
        target,
        platform: "linux",
        arch: "x64",
        version: "v0.1.0",
        releases: serve("v0.2.0", files),
        cosign: stubCosign(dir, 0),
        requireSignature: true,
      }),
    ).rejects.toThrow("published no signature over its SHA256SUMS");
    expect(readFileSync(target, "utf8")).toBe("the old perch");
    expect(existsSync(`${target}.old`)).toBe(false);
  });
});
