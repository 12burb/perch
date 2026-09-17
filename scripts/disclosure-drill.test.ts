import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAccepted, runDrill, STEPS } from "./disclosure-drill.ts";

/**
 * The disclosure drill (task 4.9).
 *
 * The acceptance is not that the script runs: it is that the drill *fails* when one of the things a
 * disclosure depends on quietly goes away. Each case below removes exactly one — the private
 * reporting path, the scheduled dependency scan, the signature over the checksums, the tamper
 * test — and asserts the step that covers it goes red.
 */

const REPO = resolve(import.meta.dir, "..");

/** A copy of the four files the drill reads, so a case can break one of them. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-drill-"));
  for (const path of [
    "SECURITY.md",
    "docs/security.md",
    "docs/install.md",
    ".github/workflows/security.yml",
    ".trivyignore.yaml",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "apps/cli/test/upgrade.test.ts",
    "apps/cli/test/install.test.ts",
  ]) {
    cpSync(join(REPO, path), join(dir, path), {
      recursive: false,
      force: true,
      errorOnExist: false,
    });
  }
  return dir;
}

/**
 * The steps that fail for a copy with one thing broken. Exactly one, always: a case that broke the
 * copy rather than the thing it meant to would fail everything, and `toContain` would not notice.
 */
function theOneFailure(repo: string): string {
  const failed = runDrill(repo).filter((one) => !one.ok);
  expect(failed.map((one) => one.step.name)).toHaveLength(1);
  return failed[0]?.step.name ?? "";
}

describe("the disclosure drill (task 4.9)", () => {
  test("this repository passes every step", () => {
    const results = runDrill(REPO);
    const failed = results.filter((one) => !one.ok);
    expect(failed.map((one) => `${one.step.name}: ${one.detail}`)).toEqual([]);
    expect(results.length).toBe(STEPS.length);
    expect(STEPS.map((one) => one.phase)).toContain("report");
    expect(STEPS.map((one) => one.phase)).toContain("tell");
  });

  test("a policy that stops offering a private path fails the report step", () => {
    const dir = scratch();
    try {
      // Everything else the drill wants is still here: only the private path is gone.
      writeFileSync(
        join(dir, "SECURITY.md"),
        [
          "# Security policy",
          "",
          "Open an issue and we will look at it.",
          "",
          "Acknowledgement within 3 days; coordinated disclosure after 90 days.",
          "",
          "## Supported versions",
          "",
          "The latest release and `main`.",
        ].join("\n"),
      );
      expect(theOneFailure(dir)).toBe(
        "There is a private way to report, and it is the only one offered",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dropping the scheduled scan fails the fix step", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, ".github/workflows/security.yml"),
        "name: Security scan\non:\n  workflow_dispatch:\njobs:\n  dependencies:\n    runs-on: ubuntu-latest\n",
      );
      expect(theOneFailure(dir)).toBe(
        "A dependency with an advisory fails something, even with nobody pushing",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a release that stops signing the checksums fails the release step", async () => {
    const dir = scratch();
    try {
      const release = await Bun.file(join(REPO, ".github/workflows/release.yml")).text();
      writeFileSync(
        join(dir, ".github/workflows/release.yml"),
        release.replace("cosign sign-blob", "echo not-signing"),
      );
      expect(theOneFailure(dir)).toBe(
        "What a stranger downloads is signed, and the SBOM is under the same signature",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a checksum file that stops covering the SBOM fails the same step", async () => {
    const dir = scratch();
    try {
      const release = await Bun.file(join(REPO, ".github/workflows/release.yml")).text();
      writeFileSync(
        join(dir, ".github/workflows/release.yml"),
        release.replace("sha256sum perch-* sbom-perch-*.spdx.json >", "sha256sum perch-* >"),
      );
      expect(theOneFailure(dir)).toBe(
        "What a stranger downloads is signed, and the SBOM is under the same signature",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("losing the tamper test fails the release step that covers it", async () => {
    const dir = scratch();
    try {
      const install = await Bun.file(join(REPO, "apps/cli/test/install.test.ts")).text();
      writeFileSync(
        join(dir, "apps/cli/test/install.test.ts"),
        install.replaceAll(/tampered/gi, "changed"),
      );
      expect(theOneFailure(dir)).toBe("A tampered download installs nothing, and a test says so");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scanning only the api image fails the image step", async () => {
    const dir = scratch();
    try {
      const ci = await Bun.file(join(REPO, ".github/workflows/ci.yml")).text();
      writeFileSync(
        join(dir, ".github/workflows/ci.yml"),
        ci.replace("image-ref: perch-runner-agents:ci", "image-ref: ghcr.io/12burb/perch-api:ci"),
      );
      expect(theOneFailure(dir)).toBe(
        "Every image Perch publishes is scanned before it is published",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the accepted findings are read: the CVE, the reason, and the date it comes back", () => {
    const accepted = parseAccepted(readFileSync(join(REPO, ".trivyignore.yaml"), "utf8"));
    expect(accepted.length).toBeGreaterThan(0);
    for (const one of accepted) {
      expect(one.id, one.id).toMatch(/^(CVE|GHSA)-/);
      expect(one.statement.length, one.id).toBeGreaterThan(40);
      expect(one.expiredAt, one.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(one.expiredAt > new Date().toISOString().slice(0, 10), one.id).toBe(true);
    }
  });

  test("an accepted finding that has run out of road fails the fix step", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, ".trivyignore.yaml"),
        [
          "vulnerabilities:",
          "  - id: CVE-2020-0001",
          "    statement: >-",
          "      Something we looked at once and never came back to, which is the failure mode this",
          "      step exists to catch.",
          "    expired_at: 2021-01-01",
        ].join("\n"),
      );
      expect(theOneFailure(dir)).toBe("Every accepted finding says why, and comes back");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an accepted finding with no reason fails the same step", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, ".trivyignore.yaml"),
        ["vulnerabilities:", "  - id: CVE-2020-0002", "    expired_at: 2099-01-01"].join("\n"),
      );
      expect(theOneFailure(dir)).toBe("Every accepted finding says why, and comes back");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a drill nobody has run fails the step that says so", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, "docs/security.md"),
        "# Security\n\nWe will run the drill one day.\n",
      );
      expect(theOneFailure(dir)).toBe("Somebody owns the drill, and it has been run");
      const result = runDrill(dir).find((one) => one.step.name.startsWith("Somebody owns"));
      expect(result?.step.manual).toContain("docs/security.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
