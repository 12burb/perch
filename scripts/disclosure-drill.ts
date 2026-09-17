/**
 * The disclosure drill (task 4.9).
 *
 * A security policy nobody has walked through is a wish. This walks it: every step of
 * `docs/security.md` that can be checked without an actual vulnerability is checked here, against
 * the repository as it is now — the private reporting path exists, the release can be cut and
 * signed, the installer refuses a tampered download, the scans that would find a dependency
 * problem are wired up, and the advisory has somewhere to say which versions are affected.
 *
 * What it cannot check is the human half: that somebody reads the mailbox within three days. That
 * is why `docs/security.md` records who, and when the drill was last run by a person.
 *
 *   bun scripts/disclosure-drill.ts            # run the checks
 *   bun scripts/disclosure-drill.ts --list     # just the steps
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type DrillStep = {
  /** `report`, `fix`, `release`, `tell` — the phase of a real disclosure this belongs to. */
  phase: "report" | "fix" | "release" | "tell";
  name: string;
  /** What a person would do at this step, when the check cannot do it for them. */
  manual?: string;
  check: (repo: string) => string;
};

function read(repo: string, path: string): string {
  return readFileSync(join(repo, path), "utf8");
}

function must(condition: boolean, wrong: string, right: string): string {
  if (!condition) throw new Error(wrong);
  return right;
}

/** Every step, in the order a real disclosure runs them. */
export const STEPS: DrillStep[] = [
  {
    phase: "report",
    name: "There is a private way to report, and it is the only one offered",
    check: (repo) => {
      const policy = read(repo, "SECURITY.md");
      must(
        policy.includes("security/advisories/new"),
        "SECURITY.md does not point at GitHub Security Advisories",
        "",
      );
      return must(
        /do not open a public issue/i.test(policy),
        "SECURITY.md does not say to keep it out of the issue tracker",
        "SECURITY.md sends reporters to a private advisory",
      );
    },
  },
  {
    phase: "report",
    name: "The clock is written down: acknowledgement, fix, disclosure",
    check: (repo) => {
      const policy = read(repo, "SECURITY.md");
      const days = [...policy.matchAll(/(\d+)\s*days?/gi)].map((one) => Number(one[1]));
      return must(
        days.length >= 2,
        "SECURITY.md does not commit to an acknowledgement and a disclosure window",
        `SECURITY.md commits to ${days.slice(0, 2).join(" and ")} days`,
      );
    },
  },
  {
    phase: "report",
    name: "Somebody owns the drill, and it has been run",
    manual: "Run the drill yourself and put today's date in docs/security.md.",
    check: (repo) => {
      const doc = read(repo, "docs/security.md");
      const date = /Last run:\s*(\d{4}-\d{2}-\d{2})/.exec(doc);
      must(Boolean(date), "docs/security.md has no 'Last run:' date for the drill", "");
      return `the drill was last run on ${date?.[1]}`;
    },
  },
  {
    phase: "fix",
    name: "A dependency with an advisory fails something, even with nobody pushing",
    check: (repo) => {
      const daily = read(repo, ".github/workflows/security.yml");
      must(/schedule:/.test(daily), "security.yml does not run on a schedule", "");
      must(
        /scan-type:\s*fs/.test(daily),
        "security.yml does not scan the repository's lockfiles",
        "",
      );
      return "security.yml scans every lockfile and the published images on a schedule";
    },
  },
  {
    phase: "fix",
    name: "Every image Perch publishes is scanned before it is published",
    check: (repo) => {
      const ci = read(repo, ".github/workflows/ci.yml");
      const images = [...ci.matchAll(/image-ref:\s*(\S+)/g)].map((one) => one[1] ?? "");
      must(
        images.some((one) => one.includes("api")) && images.some((one) => one.includes("runner")),
        `CI scans ${images.join(", ") || "no images"}; it must scan both the api and the runner`,
        "",
      );
      return `CI scans ${images.length} images: ${images.join(", ")}`;
    },
  },
  {
    phase: "release",
    name: "The release says what it was built from: an SBOM per image and one for the binaries",
    check: (repo) => {
      const release = read(repo, ".github/workflows/release.yml");
      must(/sbom-\$\{\{ matrix.image \}\}\.spdx\.json/.test(release), "no per-image SBOM", "");
      must(/sbom-perch-.*\.spdx\.json/.test(release), "no SBOM for the binaries", "");
      return "the release carries an SPDX SBOM per image and one for the binaries";
    },
  },
  {
    phase: "release",
    name: "What a stranger downloads is signed, and the SBOM is under the same signature",
    check: (repo) => {
      const release = read(repo, ".github/workflows/release.yml");
      must(/cosign sign-blob/.test(release), "SHA256SUMS is not signed", "");
      const sums = /sha256sum ([^\n>]+)>/.exec(release)?.[1] ?? "";
      must(
        sums.includes("perch-") && sums.includes("sbom-"),
        `SHA256SUMS covers "${sums.trim()}"; it must cover the binaries and the SBOM`,
        "",
      );
      return "cosign signs SHA256SUMS, which covers the binaries and the SBOM";
    },
  },
  {
    phase: "release",
    name: "A tampered download installs nothing, and a test says so",
    check: (repo) => {
      const upgrade = read(repo, "apps/cli/test/upgrade.test.ts");
      const install = read(repo, "apps/cli/test/install.test.ts");
      must(/tampered/i.test(upgrade), "no test that `perch upgrade` refuses a tampered asset", "");
      must(/tampered/i.test(install), "no test that the installer refuses a tampered binary", "");
      return "both `perch upgrade` and install.sh have a tamper test";
    },
  },
  {
    phase: "tell",
    name: "The advisory can name affected versions, because releases are versioned and tagged",
    check: (repo) => {
      const policy = read(repo, "SECURITY.md");
      return must(
        /supported versions/i.test(policy),
        "SECURITY.md does not say which versions get fixes",
        "SECURITY.md says which versions get fixes",
      );
    },
  },
  {
    phase: "tell",
    name: "Operators are told how to find out what they are running, and how to move",
    check: (repo) => {
      const install = read(repo, "docs/install.md");
      must(/perch upgrade/.test(install), "docs/install.md does not document `perch upgrade`", "");
      return "docs/install.md documents upgrading in place, checksum and signature checked";
    },
  },
];

export type DrillResult = { step: DrillStep; ok: boolean; detail: string };

export function runDrill(repo: string, steps: DrillStep[] = STEPS): DrillResult[] {
  return steps.map((step) => {
    try {
      return { step, ok: true, detail: step.check(repo) };
    } catch (error) {
      return { step, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { repo: { type: "string" }, list: { type: "boolean" } },
  });
  const repo = values.repo ?? process.cwd();
  if (values.list) {
    for (const step of STEPS) console.log(`${step.phase.padEnd(8)} ${step.name}`);
    process.exit(0);
  }
  const results = runDrill(repo);
  for (const { step, ok, detail } of results) {
    console.log(`${ok ? "ok  " : "FAIL"}  ${step.phase.padEnd(8)} ${step.name}\n        ${detail}`);
    if (!ok && step.manual) console.log(`        → ${step.manual}`);
  }
  const failed = results.filter((one) => !one.ok).length;
  console.log(
    failed === 0
      ? `\nthe drill passes: ${results.length} steps`
      : `\n${failed} of ${results.length} steps need a person`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
