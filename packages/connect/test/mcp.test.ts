import { describe, expect, test } from "bun:test";
import { allowed, argsHash, permits, type UpstreamTool } from "../src/index.ts";

/**
 * Task 1.17 (spec §7.5): the parts of the gateway that decide what a caller may see and what the
 * audit log records. Both are pure, and both are the sort of thing that is quietly wrong for
 * months if nobody pins it down.
 */

const tools: UpstreamTool[] = [
  { name: "list_issues", description: "List issues" },
  { name: "create_issue" },
  { name: "delete_repo" },
];

describe("the grant's allow-list", () => {
  test("no list means every tool; a list means exactly those, in the upstream's order", () => {
    expect(allowed(tools, null).map((t) => t.name)).toEqual([
      "list_issues",
      "create_issue",
      "delete_repo",
    ]);
    expect(allowed(tools, ["create_issue", "list_issues"]).map((t) => t.name)).toEqual([
      "list_issues",
      "create_issue",
    ]);
  });

  test("a tool nobody may call is not advertised either", () => {
    // §7.5 filters the list, not just the call: a caller should not learn that delete_repo exists.
    const visible = allowed(tools, ["list_issues"]);
    expect(visible.map((t) => t.name)).toEqual(["list_issues"]);
    expect(permits(["list_issues"], "delete_repo")).toBe(false);
    expect(permits(["list_issues"], "list_issues")).toBe(true);
    // An empty list is a list: it permits nothing, which is not the same as permitting everything.
    expect(allowed(tools, [])).toEqual([]);
    expect(permits([], "list_issues")).toBe(false);
    expect(permits(null, "delete_repo")).toBe(true);
  });
});

describe("the audit fingerprint", () => {
  test("the same call fingerprints the same way whatever order its keys arrived in", async () => {
    const one = await argsHash({ repo: "perch", owner: "12burb", state: "open" });
    const two = await argsHash({ state: "open", owner: "12burb", repo: "perch" });
    expect(one).toBe(two);
    expect(one).toHaveLength(32);
  });

  test("nested keys are ordered too, and a different call is a different fingerprint", async () => {
    const one = await argsHash({ filter: { state: "open", label: "bug" } });
    const two = await argsHash({ filter: { label: "bug", state: "open" } });
    expect(one).toBe(two);
    expect(await argsHash({ filter: { state: "closed", label: "bug" } })).not.toBe(one);
    expect(await argsHash({})).not.toBe(await argsHash({ a: 1 }));
  });

  test("a fingerprint does not carry what was in the arguments", async () => {
    const hash = await argsHash({ token: "ghp_secret_value", body: "a private note" });
    expect(hash).not.toContain("ghp");
    expect(hash).not.toContain("private");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});
