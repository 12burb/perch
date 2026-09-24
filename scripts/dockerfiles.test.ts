import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * What the images run is what their makers signed (ADR-0168, ADR-0170): no script fetched from
 * the internet is piped into a shell, and a binary downloaded in a Dockerfile is checked against
 * a signature, not only a checksum published beside it.
 */

const root = resolve(import.meta.dir, "..");
const dockerfiles = readdirSync(join(root, "deploy"))
  .filter((name) => name.startsWith("Dockerfile"))
  .map((name) => ({ name, text: readFileSync(join(root, "deploy", name), "utf8") }));

describe("the Dockerfiles", () => {
  test("there are some to check", () => {
    expect(dockerfiles.map((file) => file.name)).toContain("Dockerfile.runner");
  });

  test("no script from the internet is piped into a shell", () => {
    for (const file of dockerfiles) {
      const joined = file.text.replace(/\\\n/g, " ");
      expect(joined, file.name).not.toMatch(/(curl|wget)[^|;&]*\|\s*(ba|z)?sh\b/);
    }
  });

  test("Node's checksums are verified against Node's own release keys, at a pinned commit", () => {
    const runner = dockerfiles.find((file) => file.name === "Dockerfile.runner")?.text ?? "";
    expect(runner).toMatch(/ARG NODE_KEYS_COMMIT=[0-9a-f]{40}\n/);
    expect(runner).toContain("gpgv --keyring");
    expect(runner).toContain("SHASUMS256.txt.asc");
  });

  test("Bun and uv come out of their makers' images, not a download", () => {
    const runner = dockerfiles.find((file) => file.name === "Dockerfile.runner")?.text ?? "";
    expect(runner).toMatch(/FROM oven\/bun:\$\{BUN_VERSION\} AS bun\n/);
    expect(runner).toMatch(/FROM ghcr\.io\/astral-sh\/uv:\$\{UV_VERSION\} AS uv\n/);
    expect(runner).not.toContain("releases/download/bun-v");
    expect(runner).not.toContain("astral-sh/uv/releases/download");
  });

  test("the runner image runs its agent as root and every member as a uid of their own (ADR-0171)", () => {
    const runner = dockerfiles.find((file) => file.name === "Dockerfile.runner")?.text ?? "";
    // No USER line: the agent is root so that nothing it starts is.
    expect(runner).not.toMatch(/^USER /m);
    expect(runner).toContain("ENV PERCH_RUNNER_ISOLATION=users");
    // simple-git's git goes through the wrapper, and a checkout is the whole workspace's.
    expect(runner).toContain("COPY --chmod=755 deploy/perch-as /usr/local/bin/perch-as");
    expect(runner).toContain("git config --system safe.directory '*'");
    // What the root agent runs is root's: nothing a member or a page runs as uid 1000 can change it.
    expect(runner).not.toMatch(/--chown=perch/);
    expect(runner).not.toMatch(/chown -R perch/);
  });
});
