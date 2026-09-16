import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ACP_AGENTS } from "../src/acp.ts";
import {
  agentManifest,
  agentVersions,
  parseAgentManifest,
  probeAgentVersions,
} from "../src/agents.ts";
import { localCapabilities } from "../src/capabilities.ts";

/**
 * The official CLIs the runner image ships (task 4.6).
 *
 * The acceptance is that a runner says which four it has and at which versions, from the manifest
 * the image was built with — and that the manifest and the ACP table agree, so a machine without
 * the image fetches the same version the image installed rather than "whatever is newest today".
 */

const manifestPath = resolve(import.meta.dir, "..", "..", "..", "deploy", "agents.json");

describe("the agent manifest (task 4.6)", () => {
  const manifest = parseAgentManifest(readFileSync(manifestPath, "utf8"));

  test("pins the four official CLIs, exactly", () => {
    expect(Object.keys(manifest.agents).sort()).toEqual(["claude", "codex", "gemini", "opencode"]);
    for (const [id, agent] of Object.entries(manifest.agents)) {
      // Exact versions only: an agent that changes under a session is a change nobody chose.
      expect(agent.version, id).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(agent.package, id).not.toContain("@^");
      expect(agent.command, id).toBeTruthy();
    }
    expect(manifest.agents.codex?.acp?.command).toBe("codex-acp");
    expect(manifest.agents.claude?.acp?.command).toBe("claude-agent-acp");
  });

  test("agrees with the ACP table, so a laptop fetches the version the image installed", () => {
    const pins = new Map<string, string>();
    for (const [id, spec] of Object.entries(ACP_AGENTS)) {
      const pkg = spec.npx?.package;
      if (!pkg) continue;
      const at = pkg.lastIndexOf("@");
      pins.set(id, pkg.slice(at + 1));
    }
    // Where the image ships a bridge, the table's npx pin is that bridge's version; where the CLI
    // speaks ACP itself (gemini), it is the CLI's own.
    expect(pins.get("codex")).toBe(manifest.agents.codex?.acp?.version);
    expect(pins.get("claude")).toBe(manifest.agents.claude?.acp?.version);
    expect(pins.get("gemini")).toBe(manifest.agents.gemini?.version);
    // OpenCode is launched by its own binary, so the table has no npx pin for it to drift from.
    expect(pins.has("opencode")).toBe(false);
  });

  test("a runner with a manifest reports what it was built with, and only what is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "perch-agents-"));
    const path = join(dir, "agents.json");
    writeFileSync(path, readFileSync(manifestPath, "utf8"));
    const loaded = agentManifest(path);
    expect(loaded).not.toBeNull();

    // Everything installed: four versions, straight from the manifest.
    expect(agentVersions({ manifest: loaded, which: () => "/usr/local/bin/x" })).toEqual({
      codex: manifest.agents.codex?.version ?? "",
      claude: manifest.agents.claude?.version ?? "",
      gemini: manifest.agents.gemini?.version ?? "",
      opencode: manifest.agents.opencode?.version ?? "",
    });

    // Nothing on PATH: a manifest is not a promise that the binary is still there.
    expect(agentVersions({ manifest: loaded, which: () => null })).toEqual({});

    // One of them removed after the fact.
    const versions = agentVersions({
      manifest: loaded,
      which: (command) => (command === "codex" ? null : `/usr/local/bin/${command}`),
    });
    expect(Object.keys(versions).sort()).toEqual(["claude", "gemini", "opencode"]);
  });

  test("a runner without one asks the CLIs themselves, and lists none it cannot find", () => {
    expect(agentManifest(join(tmpdir(), "no-such-manifest.json"))).toBeNull();
    // `bun --version` stands in for a CLI that is really here; the rest are not.
    const probed = probeAgentVersions({ bun: "bun", nothing: "perch-no-such-command" });
    expect(probed.bun).toMatch(/^\d+\.\d+\.\d+/);
    expect(probed.nothing).toBeUndefined();
  });

  test("capabilities carry the versions, so the Environments page can say which Codex", () => {
    const capabilities = localCapabilities();
    expect(capabilities.versions?.bun).toBe(Bun.version);
    // This machine is not the image, so the four are absent rather than invented.
    expect(capabilities.versions).toBeDefined();
  });
});
