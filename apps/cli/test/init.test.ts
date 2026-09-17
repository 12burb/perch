import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderInit, writeInit } from "../src/commands/init.ts";
import { main } from "../src/index.ts";
import { currentVersion } from "../src/upgrade.ts";

const base = {
  dir: "",
  publicUrl: "https://perch.example.com/",
  dnsProvider: "cloudflare",
  telemetry: false,
  imageTag: "1.2.3",
  force: false,
};
const secrets = { masterKey: "MASTERKEY", postgresPassword: "PGPASS" };

describe("perch init (task 0.13)", () => {
  test("renders .env with the public origin, generated secrets, pinned images, and telemetry off", () => {
    const files = renderInit(base, secrets);
    expect(files.env).toContain("PERCH_PUBLIC_URL=https://perch.example.com\n");
    expect(files.env).toContain("PERCH_MASTER_KEY=MASTERKEY\n");
    expect(files.env).toContain("POSTGRES_PASSWORD=PGPASS\n");
    expect(files.env).toContain("PERCH_IMAGE_TAG=1.2.3\n");
    expect(files.env).toContain("PERCH_TELEMETRY=off\n");
    expect(files.env).not.toContain("\nPERCH_PREVIEW_DOMAIN=");
    expect(files.caddyfile).toContain("{$PERCH_PUBLIC_URL}");
    expect(files.caddyfile).not.toContain("PERCH_PREVIEW_DOMAIN");
    expect(files.compose).toMatch(/ghcr\.io\/12burb\/perch-api:\$\{PERCH_IMAGE_TAG:-latest\}/);
    expect(files.compose).toContain("/var/run/docker.sock");
    // Only the supervisor mounts the Docker socket (spec §1.6).
    expect(files.compose.split("/var/run/docker.sock:/var/run/docker.sock").length - 1).toBe(1);
  });

  test("a preview domain adds the wildcard Caddyfile and the DNS settings", () => {
    const files = renderInit(
      { ...base, previewDomain: "preview.example.com", dnsToken: "tok", telemetry: true },
      secrets,
    );
    expect(files.env).toContain("PERCH_PREVIEW_DOMAIN=preview.example.com\n");
    expect(files.env).toContain("CADDY_DNS_PROVIDER=cloudflare\n");
    expect(files.env).toContain("CADDY_DNS_TOKEN=tok\n");
    expect(files.env).toContain("PERCH_TELEMETRY=on\n");
    expect(files.caddyfile).toContain("*.{$PERCH_PREVIEW_DOMAIN}");
    expect(files.caddyfile).toContain("dns {$CADDY_DNS_PROVIDER} {$CADDY_DNS_TOKEN}");
  });

  test("writes the three files with a private .env and refuses to overwrite without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-init-"));
    try {
      const options = { ...base, dir };
      const written = writeInit(options, renderInit(options, secrets));
      expect(written.map((p) => p.slice(dir.length + 1))).toEqual([
        ".env",
        "docker-compose.yml",
        "Caddyfile",
      ]);
      // POSIX permissions only; Windows has no mode bits to check.
      if (process.platform !== "win32")
        expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain(
        "pgvector/pgvector:0.8.6-pg16",
      );
      expect(() => writeInit(options, renderInit(options, secrets))).toThrow(/--force/);
      writeInit({ ...options, force: true }, renderInit(options, secrets));
      expect(existsSync(join(dir, "Caddyfile"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test("the command line: --yes without --public-url fails; with it, files are written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-init-cli-"));
    try {
      expect(await main(["init", "--yes", "--dir", dir])).toBe(2);
      expect(
        await main([
          "init",
          "--yes",
          "--dir",
          dir,
          "--public-url",
          "https://perch.example.com",
          "--image-tag",
          "0.1.0",
        ]),
      ).toBe(0);
      const env = readFileSync(join(dir, ".env"), "utf8");
      expect(env).toContain("PERCH_IMAGE_TAG=0.1.0");
      expect(env).toMatch(/PERCH_MASTER_KEY=[A-Za-z0-9+/=]{40,}/);
      expect(await main(["nope"])).toBe(2);
      expect(await main([])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

/**
 * What a downloaded binary answers before it is asked to do anything (v0.3.0's own first minute):
 * the version, and a diagnostic that does not cry wolf about the web app it is carrying.
 */
describe("the first thing anybody types", () => {
  test("`perch --version`, `-v` and `version` all say the version", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const said: string[] = [];
      const log = console.log;
      console.log = (line: string) => said.push(String(line));
      try {
        expect(await main(argv)).toBe(0);
      } finally {
        console.log = log;
      }
      expect(said.join("\n").trim()).toBe(currentVersion());
    }
  });

  test("the help lists it, so it is discoverable from the binary itself", async () => {
    const said: string[] = [];
    const log = console.log;
    console.log = (line: string) => said.push(String(line));
    try {
      expect(await main(["help"])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(said.join("\n")).toContain("version");
  });
});
