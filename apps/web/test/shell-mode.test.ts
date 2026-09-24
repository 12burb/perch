import { describe, expect, test } from "bun:test";
import { modeFromPath } from "../src/shell/app-shell.tsx";

/** Which rail mode a path is in (spec §4), and a workspace whose slug starts like a route (A-wc-22). */
describe("modeFromPath", () => {
  test("a workspace whose slug starts with 'settings' is in its own modes", () => {
    expect(modeFromPath("/settings-lab/code", "settings-lab")).toBe("code");
    expect(modeFromPath("/settings-lab/home/general", "settings-lab")).toBe("home");
    expect(modeFromPath("/settingsx", null)).toBe("home");
  });

  test("the account settings and a workspace's settings are Settings", () => {
    expect(modeFromPath("/settings", null)).toBe("settings");
    expect(modeFromPath("/settings/profile", null)).toBe("settings");
    expect(modeFromPath("/acme/settings", "acme")).toBe("settings");
    expect(modeFromPath("/acme/environments", "acme")).toBe("settings");
  });

  test("the rail's modes, the welcome page, and the rest", () => {
    expect(modeFromPath("/acme/work", "acme")).toBe("work");
    expect(modeFromPath("/acme/code/site", "acme")).toBe("code");
    expect(modeFromPath("/welcome", null)).toBe("welcome");
    expect(modeFromPath("/acme/hub", "acme")).toBe("home");
  });
});
