import { describe, expect, test } from "bun:test";
import {
  browserCandidates,
  collect,
  findBrowser,
  NoBrowser,
  type PageConsoleLine,
  type PageFailedRequest,
  visit,
} from "../src/screenshot.ts";

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

/**
 * Task 3.21: the visit, which is the screenshot with a verdict attached. It needs a real browser,
 * so it runs where there is one — which is the hosted image, a developer's laptop, and CI.
 */
const browser = findBrowser();

describe.skipIf(!browser)("visiting a page (task 3.21)", () => {
  test("a picture, what the page logged, and what it failed to fetch", async () => {
    const page = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (new URL(request.url).pathname === "/missing")
          return new Response("no", { status: 404 });
        return new Response(
          `<!doctype html><html><body><h1>hi</h1><script>
             console.log("a fine thing");
             console.error("a bad thing");
             fetch("/missing");
             setTimeout(() => { undefinedFunction(); }, 10);
           </script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    try {
      const seen = await visit({ port: page.port ?? 0, path: "/", width: 400, height: 300 });
      expect(seen.png.length).toBeGreaterThan(100);
      expect(seen.width).toBe(400);

      // The level the page meant, which is the whole reason this is not `--screenshot`.
      const levels = new Map(seen.console.map((one) => [one.text, one.level]));
      expect(levels.get("a fine thing")).toBe("log");
      expect(levels.get("a bad thing")).toBe("error");
      // And an uncaught exception is an error whatever the page thought it was doing.
      expect(
        seen.console.some((one) => one.level === "error" && one.text.includes("undefinedFunction")),
      ).toBe(true);
      // The request that did not come back.
      expect(seen.failed.some((one) => one.status === 404 && one.url.endsWith("/missing"))).toBe(
        true,
      );
    } finally {
      page.stop(true);
    }
  }, 120_000);
});

describe("collect", () => {
  test("a console call, an exception, and a failed response", () => {
    const lines: PageConsoleLine[] = [];
    const failed: PageFailedRequest[] = [];
    collect(
      {
        method: "Runtime.consoleAPICalled",
        params: { type: "warn", args: [{ value: "careful" }] },
      },
      lines,
      failed,
    );
    collect(
      { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "boom" } } },
      lines,
      failed,
    );
    collect(
      { method: "Network.responseReceived", params: { response: { url: "/x", status: 500 } } },
      lines,
      failed,
    );
    // A response that came back fine is not a failure.
    collect(
      { method: "Network.responseReceived", params: { response: { url: "/y", status: 200 } } },
      lines,
      failed,
    );
    expect(lines).toEqual([
      { level: "warn", text: "careful" },
      { level: "error", text: "boom" },
    ]);
    expect(failed).toEqual([{ url: "/x", status: 500 }]);
  });
});
