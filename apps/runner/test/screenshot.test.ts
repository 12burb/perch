import { describe, expect, test } from "bun:test";
import { browserCandidates, findBrowser, NoBrowser } from "../src/screenshot.ts";

/**
 * Task 2.16 (spec §5.6): the runner's screenshot. What a unit test can hold it to is where it looks
 * for a browser, in which order, and that a runner without one says so rather than failing oddly.
 */

describe("the runner's screenshot", () => {
  test("the operator's choice comes before anything installed", () => {
    const found = browserCandidates({
      PERCH_CHROMIUM: "/opt/mine/chrome",
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/opt/pw/chrome",
    });
    expect(found[0]).toBe("/opt/mine/chrome");
    expect(found[1]).toBe("/opt/pw/chrome");
    expect(found).toContain("/usr/bin/chromium");
  });

  test("a path that is not there is not a browser", () => {
    // Whether this machine has one of the known browsers is not this test's business; that the
    // named path is skipped because nothing is at it, is.
    expect(findBrowser({ PERCH_CHROMIUM: "/nowhere/chrome" })).not.toBe("/nowhere/chrome");
  });

  test("a runner with no browser says what to do about it", () => {
    // Not by calling `screenshot`: whether this machine has a browser is the machine's business,
    // and on one that does the call would really start Chromium and wait for it.
    expect(new NoBrowser().message).toContain("PERCH_CHROMIUM");
    expect(new NoBrowser().name).toBe("NoBrowser");
  });
});
