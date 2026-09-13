import { describe, expect, test } from "bun:test";
import {
  apiTokenScopesSchema,
  messageBlocksSchema,
  projectConfigSchema,
  runnerCapabilitiesSchema,
  workspaceSettingsSchema,
} from "../src/shapes/index.ts";

describe("jsonb shapes", () => {
  test("project config accepts the documented .perch/project.json keys and rejects unknown ones", () => {
    expect(
      projectConfigSchema.parse({
        engine: "opencode",
        run: { test: "bun test", dev: "bun dev" },
        preview: { command: "bun dev", port: 5173, routes: ["/", "/pricing"] },
      }),
    ).toMatchObject({ engine: "opencode" });
    expect(projectConfigSchema.safeParse({ engine: "magic" }).success).toBe(false);
    expect(projectConfigSchema.safeParse({ preview: { port: 70000 } }).success).toBe(false);
    expect(projectConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  test("message blocks are a discriminated union with text extractable for search", () => {
    const blocks = messageBlocksSchema.parse([
      { type: "text", text: "hi" },
      { type: "approve_deny", text: "Deploy?", action: "deploy" },
      { type: "progress", value: 0.5 },
    ]);
    expect(blocks).toHaveLength(3);
    expect(messageBlocksSchema.safeParse([{ type: "poll", options: [] }]).success).toBe(false);
    expect(messageBlocksSchema.safeParse([{ type: "progress", value: 2 }]).success).toBe(false);
  });

  test("api token scopes, workspace settings, and runner capabilities are strict", () => {
    expect(apiTokenScopesSchema.parse(["read", "sessions:open"])).toEqual([
      "read",
      "sessions:open",
    ]);
    expect(apiTokenScopesSchema.safeParse(["root"]).success).toBe(false);
    expect(workspaceSettingsSchema.parse({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(workspaceSettingsSchema.safeParse({ theme: "neon" }).success).toBe(false);
    expect(runnerCapabilitiesSchema.parse({ pty: true, engines: ["acp"] })).toEqual({
      pty: true,
      engines: ["acp"],
    });
  });
});
