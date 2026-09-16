import { describe, expect, test } from "bun:test";
import { type ProjectStatus, unsettled } from "../src/code/project-status.ts";

/**
 * ADR-0115: a missed `project.updated` used to leave "Setting up" on a project that was ready. The
 * poller is the fallback, and what it asks is this.
 */

const rows = (...statuses: ProjectStatus[]) => statuses.map((status) => ({ status }));

describe("a project list that is still moving", () => {
  test("is one with a project being set up", () => {
    expect(unsettled(rows("setting_up"))).toBe(true);
    expect(unsettled(rows("pending"))).toBe(true);
    expect(unsettled(rows("ready", "setting_up"))).toBe(true);
  });

  test("is not one where everything has settled, one way or the other", () => {
    expect(unsettled(rows("ready"))).toBe(false);
    expect(unsettled(rows("error"))).toBe(false);
    expect(unsettled(rows("ready", "error"))).toBe(false);
    expect(unsettled([])).toBe(false);
    expect(unsettled(undefined)).toBe(false);
  });
});
