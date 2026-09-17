import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { bare, packagingFor, parseSums } from "./packaging.ts";

/**
 * The package-manager manifests (task 4.3). What matters is that every file carries the version
 * and the checksum the release actually published, because a manifest with a stale checksum is an
 * install that fails for a stranger.
 */

const SUMS = `${"1".repeat(64)}  perch-linux-x64
${"2".repeat(64)}  perch-linux-arm64
${"3".repeat(64)}  perch-darwin-x64
${"4".repeat(64)}  perch-darwin-arm64
${"5".repeat(64)} *perch-windows-x64.exe
`;

describe("packaging manifests (task 4.3)", () => {
  test("reads the release's own checksum file", () => {
    const sums = parseSums(SUMS);
    expect(sums["perch-linux-x64"]).toBe("1".repeat(64));
    expect(sums["perch-windows-x64.exe"]).toBe("5".repeat(64));
    expect(bare("v0.2.0")).toBe("0.2.0");
  });

  test("writes Homebrew, winget, the AUR and nix with that version and those checksums", () => {
    const files = packagingFor("v0.2.0", parseSums(SUMS));
    expect(Object.keys(files).sort()).toEqual([
      "aur/PKGBUILD",
      "homebrew/perch.rb",
      "nix/flake.nix",
      "winget/Perch.Perch.installer.yaml",
      "winget/Perch.Perch.locale.en-US.yaml",
      "winget/Perch.Perch.yaml",
    ]);

    const brew = files["homebrew/perch.rb"] ?? "";
    expect(brew).toContain('version "0.2.0"');
    expect(brew).toContain("releases/download/v0.2.0/perch-darwin-arm64");
    expect(brew).toContain(`sha256 "${"4".repeat(64)}"`);

    const pkgbuild = files["aur/PKGBUILD"] ?? "";
    expect(pkgbuild).toContain("pkgver=0.2.0");
    expect(pkgbuild).toContain(`sha256sums_aarch64=('${"2".repeat(64)}')`);

    const flake = files["nix/flake.nix"] ?? "";
    expect(flake).toContain(`"aarch64-darwin"`);
    expect(flake).toContain(`sha256 = "${"3".repeat(64)}"`);
    // The interpolations nix does itself must survive being written from a template literal.
    expect(flake).toContain(`nixpkgs.legacyPackages.\${system}`);

    // winget is read back as YAML, because winget will.
    const installer = parse(files["winget/Perch.Perch.installer.yaml"] ?? "") as {
      PackageIdentifier: string;
      PackageVersion: string;
      Installers: { Architecture: string; InstallerUrl: string; InstallerSha256: string }[];
    };
    expect(installer.PackageIdentifier).toBe("Perch.Perch");
    expect(installer.PackageVersion).toBe("0.2.0");
    expect(installer.Installers[0]?.InstallerSha256).toBe("5".repeat(64).toUpperCase());
    expect(installer.Installers[0]?.InstallerUrl).toContain("perch-windows-x64.exe");
    const version = parse(files["winget/Perch.Perch.yaml"] ?? "") as {
      ManifestType: string;
      ManifestVersion: string;
      PackageVersion: string;
    };
    expect(version.ManifestType).toBe("version");
    // Quoted, or a YAML reader turns 1.6.0-shaped scalars into numbers.
    expect(version.ManifestVersion).toBe("1.6.0");
    expect(version.PackageVersion).toBe("0.2.0");
    const locale = parse(files["winget/Perch.Perch.locale.en-US.yaml"] ?? "") as {
      ShortDescription: string;
    };
    expect(locale.ShortDescription).toContain("agentic workspace");
  });

  test("an asset the release did not publish is an error, not a blank checksum", () => {
    expect(() => packagingFor("v0.2.0", parseSums(`${"1".repeat(64)}  perch-linux-x64\n`))).toThrow(
      "SHA256SUMS has no line for perch-darwin-arm64",
    );
  });

  test("the release workflow attaches every file this generates", () => {
    const workflow = readFileSync(
      resolve(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(workflow).toContain("bun scripts/packaging.ts");
    expect(workflow).toContain("release/packaging");
  });
});

/**
 * The flake at the root of the repository, which is what `nix run github:12burb/perch` resolves —
 * the one package-manager lane that needs no registry and no credential, and therefore the one
 * that has to be right.
 */
describe("the manifests on the default branch (nix run, brew tap)", () => {
  const root = resolve(import.meta.dir, "..");
  const committed = readFileSync(resolve(root, "flake.nix"), "utf8");
  const formula = readFileSync(resolve(root, "Formula", "perch.rb"), "utf8");

  test("it names a released version and a checksum per platform", () => {
    const version = /version = "([^"]+)"/.exec(committed)?.[1] ?? "";
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(committed).toContain(`releases/download/v${version}/`);
    for (const asset of [
      "perch-linux-x64",
      "perch-linux-arm64",
      "perch-darwin-x64",
      "perch-darwin-arm64",
    ]) {
      const found = new RegExp(`asset = "${asset}"; sha256 = "([0-9a-f]{64})"`).exec(committed);
      expect(found?.[1], asset).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("it is what the generator writes, so nobody has edited it by hand", () => {
    // The header says not to, and a hand-edited hash is an install that fails for a stranger with
    // a message about a hash mismatch and no way to tell which side is wrong.
    const version = /version = "([^"]+)"/.exec(committed)?.[1] ?? "";
    const sums = [...committed.matchAll(/asset = "([^"]+)"; sha256 = "([0-9a-f]{64})"/g)]
      .map(([, asset, hash]) => `${hash}  ${asset}`)
      .join("\n");
    // The generator needs the Windows asset too; it does not appear in the flake, so it is only
    // here to satisfy the reader, with a hash that cannot be mistaken for a real one.
    const windows = `${"0".repeat(64)}  perch-windows-x64.exe`;
    const regenerated = packagingFor(`v${version}`, parseSums(`${sums}\n${windows}\n`))[
      "nix/flake.nix"
    ];
    expect(typeof regenerated).toBe("string");
    expect(committed).toBe(regenerated ?? "");
  });

  test("the formula names the same release as the flake", () => {
    // `brew tap <user>/<name> <url>` clones this repository and reads Formula/, so the two lanes
    // that need no registry are served from the same commit and must not drift apart.
    const flakeVersion = /version = "([^"]+)"/.exec(committed)?.[1] ?? "";
    const formulaVersion = /^ {2}version "([^"]+)"$/m.exec(formula)?.[1] ?? "";
    expect(formulaVersion).toBe(flakeVersion);
    expect(formula).toContain(`releases/download/v${formulaVersion}/perch-darwin-arm64`);
    expect(formula).toContain(`releases/download/v${formulaVersion}/perch-linux-x64`);
  });

  test("the formula carries the same checksums, so one cannot be refreshed without the other", () => {
    for (const [, asset, hash] of committed.matchAll(
      /asset = "([^"]+)"; sha256 = "([0-9a-f]{64})"/g,
    )) {
      const inFormula = new RegExp(
        `download/v[^/]+/${asset}"\\s+sha256 "([0-9a-f]{64})"`,
        "m",
      ).exec(formula);
      expect(inFormula?.[1], asset).toBe(hash);
    }
  });
});
