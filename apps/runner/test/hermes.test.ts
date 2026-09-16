import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERMES_AGENT,
  HERMES_LAUNCHERS,
  HERMES_VERSION,
  hermesEnv,
  hermesInstalled,
  resolveHermes,
} from "../src/hermes.ts";

/**
 * Task 3.8 (spec §3.3 `hermes`): the pieces of the Hermes engine that are decisions rather than
 * protocol. What the protocol does is ACP's, and is covered by the ACP adapter's own tests and by
 * the api's two-turn session test — this is how Hermes is found and what it is told.
 */

function shim(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-hermes-"));
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("the Hermes engine (task 3.8)", () => {
  test("it is launched with `hermes acp`, and `hermes-acp` when that is what is there", () => {
    expect(HERMES_LAUNCHERS[0]).toMatchObject({ command: "hermes", args: ["acp"] });
    expect(HERMES_LAUNCHERS[1]).toMatchObject({ command: "hermes-acp" });
    expect(HERMES_AGENT).toEqual({ id: "hermes", name: "Hermes Agent" });
    // Pinned, like every other dependency (AGENTS.md §1.3, docs/dependencies.md).
    expect(HERMES_VERSION).toMatch(/^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/);
  });

  test("PERCH_HERMES_COMMAND names a checkout the PATH does not reach", () => {
    const file = shim("hermes");
    const found = resolveHermes({ PERCH_HERMES_COMMAND: `${file} acp` });
    expect(found).toEqual({ file, args: ["acp"] });
    expect(hermesInstalled({ PERCH_HERMES_COMMAND: `${file} acp` })).toBe(true);
    // A command that is not there is not a command: better a clear refusal than a spawn that fails.
    expect(resolveHermes({ PERCH_HERMES_COMMAND: "/nowhere/hermes acp" })).toBeNull();
    expect(hermesInstalled({ PERCH_HERMES_COMMAND: "/nowhere/hermes" })).toBe(false);
  });

  test("a runner with no Hermes says so rather than half-hosting it", () => {
    // An empty environment has no PATH, so `Bun.which` finds nothing — the same answer a machine
    // without Hermes gives.
    expect(resolveHermes({ PERCH_HERMES_COMMAND: "" })).toEqual(
      resolveHermes({ PERCH_HERMES_COMMAND: undefined }),
    );
  });

  test("the brain travels as HERMES_INFERENCE_MODEL, and the engine's own default as nothing", () => {
    expect(hermesEnv({ provider: "nous", modelId: "hermes-4-70b" })).toEqual({
      HERMES_INFERENCE_MODEL: "hermes-4-70b",
    });
    expect(hermesEnv({ provider: "openrouter", modelId: "z-ai/glm-4.7" })).toEqual({
      HERMES_INFERENCE_MODEL: "z-ai/glm-4.7",
    });
    // "the engine's own choice" is exactly the case where Perch should say nothing at all.
    expect(hermesEnv({ provider: "engine", modelId: "default" })).toEqual({});
    expect(hermesEnv({ provider: "default", modelId: "default" })).toEqual({});
    expect(hermesEnv({})).toEqual({});
    expect(hermesEnv()).toEqual({});
  });
});
