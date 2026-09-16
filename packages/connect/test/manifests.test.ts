import { describe, expect, test } from "bun:test";
import { MANIFESTS } from "@perch/connectors";
import { checkManifest, reportLines } from "../src/harness.ts";

/**
 * Task 3.11: every connector this build ships, put through the harness. A manifest is a YAML file
 * a person edits, so the thing worth testing is not that one of them is right — it is that any of
 * them being wrong is caught here rather than the first time somebody connects.
 */

describe("the connector manifests (task 3.11)", () => {
  for (const [id, source] of Object.entries(MANIFESTS)) {
    test(`${id} is a manifest Perch could work with`, async () => {
      const report = await checkManifest(source, id);
      // The lines are what a person would read; failing with them beats failing with `false`.
      expect(reportLines(report).filter((line) => line.startsWith("FAIL"))).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.manifest?.id).toBe(id);
    });
  }

  test("a provider that signs nothing is said out loud, not waved through", async () => {
    const report = await checkManifest(`
id: quiet
name: Quiet
summary: A provider with no signature scheme at all.
auth: [token]
api_base: https://api.quiet.test
test_path: /me
`);
    // Not an error — some providers really do not sign — but never silent either.
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ level: "warning", field: "webhook_signature" });
  });

  test("a manifest that claims to sign but does not is caught", async () => {
    const report = await checkManifest(`
id: sloppy
name: Sloppy
summary: A provider that does not sign what it sends.
auth: [token]
api_base: https://api.sloppy.test
test_path: /me
webhook_signature: hmac_sha256
webhook:
  header: x-sloppy-signature
  signed: "a constant"
`);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report.findings)).toContain("signs nothing");
  });

  test("a manifest whose lanes do not add up is caught", async () => {
    const report = await checkManifest(`
id: hopeful
name: Hopeful
summary: Offers a lane it has no server for, and a paste lane it cannot check.
auth: [mcp_oauth, token]
api_base: https://api.hopeful.test
`);
    expect(report.ok).toBe(false);
    const fields = report.findings.map((one) => one.field).sort();
    // No server for the MCP lane, no way to check a pasted token, and nothing signed — all three
    // findable without asking Hopeful anything.
    expect(fields).toEqual(["mcp_url", "test_path", "webhook_signature"]);
  });

  test("the schema refuses the shapes that are not manifests at all", async () => {
    // `parseManifest` owns the lanes it can decide alone; the harness reports what it said rather
    // than checking the same thing twice.
    const report = await checkManifest(`
id: partial
name: Partial
summary: Says oauth2 without saying where.
auth: [oauth2]
api_base: https://api.partial.test
`);
    expect(report.ok).toBe(false);
    expect(report.manifest).toBeNull();
    expect(report.findings[0]?.message).toContain("needs an oauth block");
  });

  test("a directory name that disagrees with the manifest is caught", async () => {
    const report = await checkManifest(MANIFESTS.github ?? "", "gitbub");
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report.findings)).toContain("the directory is gitbub");
  });
});
