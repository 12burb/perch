import { describe, expect, test } from "bun:test";
import { projectConfigSchema } from "@perch/db";
import { STACKS, stackById, stackFiles } from "../src/stacks.ts";

/**
 * The starter stacks (task 4.8): four of them, each a project that runs.
 *
 * The test that matters is the last one: a stack's `.perch/project.json` has to be a document
 * Perch itself accepts, or the project it makes has a preview nobody can start.
 */

describe("starter stacks (task 4.8)", () => {
  test("four of them, each with an id, a port and a command", () => {
    expect(STACKS.map((stack) => stack.id)).toEqual([
      "bun-api",
      "next-app",
      "python-api",
      "static-site",
    ]);
    for (const stack of STACKS) {
      expect(stack.name, stack.id).toMatch(/\S/);
      expect(stack.description, stack.id).toMatch(/\S/);
      expect(stack.tags.length, stack.id).toBeGreaterThan(0);
      expect(stack.port, stack.id).toBeGreaterThan(0);
      expect(stack.dev, stack.id).toMatch(/\S/);
    }
    expect(stackById("bun-api")?.name).toBe("Bun API");
    expect(stackById("nothing-here")).toBeUndefined();
  });

  test("every file has a relative path and something in it", () => {
    for (const stack of STACKS) {
      const files = stackFiles(stack);
      expect(files.length, stack.id).toBeGreaterThan(2);
      for (const file of files) {
        expect(file.path, stack.id).not.toStartWith("/");
        expect(file.path, stack.id).not.toContain("..");
        expect(file.content.length, `${stack.id}:${file.path}`).toBeGreaterThan(0);
      }
      // A README and a project document, always: one for the person, one for Perch.
      expect(Object.keys(stack.files), stack.id).toContain("README.md");
      expect(Object.keys(stack.files), stack.id).toContain(".perch/project.json");
    }
  });

  test("every dependency is pinned exactly, the way this repository pins everything", () => {
    for (const stack of STACKS) {
      const manifest = stack.files["package.json"];
      if (manifest) {
        const parsed = JSON.parse(manifest) as { dependencies?: Record<string, string> };
        for (const [name, version] of Object.entries(parsed.dependencies ?? {})) {
          expect(version, `${stack.id}:${name}`).toMatch(/^\d+\.\d+\.\d+$/);
        }
      }
      const pyproject = stack.files["pyproject.toml"];
      if (pyproject) {
        expect(pyproject, stack.id).not.toContain(">=0");
        expect(pyproject, stack.id).toContain("==");
      }
    }
  });

  test("the project document is one Perch accepts, and names the stack's own port", () => {
    for (const stack of STACKS) {
      const raw = stack.files[".perch/project.json"] ?? "";
      const config = projectConfigSchema.parse(JSON.parse(raw));
      expect(config.preview?.port, stack.id).toBe(stack.port);
      expect(config.preview?.command, stack.id).toBe(stack.dev);
      expect(config.run?.dev, stack.id).toBe(stack.dev);
    }
  });
});
