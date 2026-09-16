import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestsAt, runConnectors } from "../src/commands/connectors.ts";

/**
 * Task 3.11: `perch connectors check` is the harness a person writing a manifest can run. What
 * matters is the exit code — a manifest Perch could not work with must not pass quietly — and that
 * it reads the same `<id>/manifest.yaml` layout `PERCH_CONNECTORS_DIR` does.
 */

const GOOD = `id: acme
name: Acme
summary: A provider that exists as a file.
auth: [token]
api_base: https://api.acme.test
test_path: /whoami
webhook_signature: hmac_sha256
webhook:
  header: x-acme-signature
  prefix: "sha256="
  encoding: hex
  signed: "{body}"
  id_header: x-acme-delivery
`;

const BAD = `id: sloppy
name: Sloppy
summary: Claims to sign and does not.
auth: [token]
api_base: https://api.sloppy.test
test_path: /me
webhook_signature: hmac_sha256
webhook:
  header: x-sloppy-signature
  signed: "a constant"
`;

function dirWith(manifests: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-cli-connectors-"));
  for (const [id, source] of Object.entries(manifests)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, "manifest.yaml"), source);
  }
  return dir;
}

async function quietly(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    return { code: await run(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("perch connectors check (task 3.11)", () => {
  test("a directory of manifests, all usable", async () => {
    const dir = dirWith({ acme: GOOD });
    try {
      const { code, out } = await quietly(() => runConnectors(["check", dir]));
      expect(code).toBe(0);
      expect(out).toContain("ok    acme");
      expect(out).toContain("1 manifest checked, all usable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one that would not work fails the command, and says which and why", async () => {
    const dir = dirWith({ acme: GOOD, sloppy: BAD });
    try {
      const { code, out } = await quietly(() => runConnectors(["check", dir]));
      expect(code).toBe(1);
      expect(out).toContain("FAIL  sloppy");
      expect(out).toContain("signs nothing");
      expect(out).toContain("1 of 2 would not work");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every connector this build ships passes it", async () => {
    const shipped = join(import.meta.dir, "..", "..", "..", "connectors");
    const { code, out } = await quietly(() => runConnectors(["check", shipped]));
    expect(out).not.toContain("FAIL");
    expect(code).toBe(0);
  });

  test("with nothing named it checks PERCH_CONNECTORS_DIR, which is where a file goes", async () => {
    const dir = dirWith({ sloppy: BAD });
    const had = process.env.PERCH_CONNECTORS_DIR;
    process.env.PERCH_CONNECTORS_DIR = dir;
    try {
      const { code, out } = await quietly(() => runConnectors(["check"]));
      expect(code).toBe(1);
      expect(out).toContain("FAIL  sloppy");
    } finally {
      if (had === undefined) delete process.env.PERCH_CONNECTORS_DIR;
      else process.env.PERCH_CONNECTORS_DIR = had;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it reads the layout PERCH_CONNECTORS_DIR reads, and ignores what is not a connector", () => {
    const dir = dirWith({ acme: GOOD });
    mkdirSync(join(dir, "src"));
    try {
      expect(manifestsAt(dir).map((one) => one.id)).toEqual(["acme"]);
      expect(manifestsAt(join(dir, "acme", "manifest.yaml"))[0]?.id).toBe("acme");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
