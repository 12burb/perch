import { describe, expect, test } from "bun:test";
import {
  allowNonce,
  INSPECTOR_PATH,
  injectInspector,
  isHtml,
  withInspector,
} from "../src/inject.ts";

/**
 * Task 2.16 (spec §5.6): the injection. The rules worth pinning are the ones that keep the
 * inspector out of places it must not be — a share link's page, an asset, a second copy of itself —
 * and the one that keeps a dev server's own CSP intact while letting this one script through.
 */

const options = { nonce: "abc", scriptUrl: INSPECTOR_PATH };

describe("injecting the inspector", () => {
  test("the script goes in before </head>, once", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    const once = injectInspector(html, options);
    expect(once).toContain(`<script data-perch-inspector="abc" src="${INSPECTOR_PATH}?nonce=abc"`);
    expect(once.indexOf("<script")).toBeLessThan(once.indexOf("</head>"));
    expect(injectInspector(once, options)).toBe(once);
  });

  test("a document with no head gets it at the top of the body", () => {
    const html = "<body><p>hi</p></body>";
    expect(injectInspector(html, options)).toBe(
      `<body><script data-perch-inspector="abc" src="${INSPECTOR_PATH}?nonce=abc" defer></script><p>hi</p></body>`,
    );
  });

  test("a document with neither is left exactly as it was", () => {
    expect(injectInspector("just text", options)).toBe("just text");
  });

  test("only HTML is rewritten", async () => {
    const script = new Response("console.log(1)", {
      headers: { "content-type": "text/javascript" },
    });
    expect(isHtml(script)).toBe(false);
    expect(await (await withInspector(script, options)).text()).toBe("console.log(1)");

    const page = new Response("<html><head></head><body></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8", "content-length": "39" },
    });
    const injected = await withInspector(page, options);
    expect(await injected.text()).toContain("data-perch-inspector");
    // The length was the dev server's, and it is no longer true.
    expect(injected.headers.get("content-length")).toBeNull();
  });

  test("a dev server's CSP keeps its rules and gains one nonce", () => {
    expect(allowNonce("default-src 'self'; script-src 'self'", "abc")).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc'",
    );
    // No script-src: the nonce goes on one derived from default-src rather than the rule being cut.
    expect(allowNonce("default-src 'self' https:", "abc")).toBe(
      "default-src 'self' https:; script-src 'self' https: 'nonce-abc'",
    );
    // Nothing to attach to: the policy is the dev server's and is left alone.
    expect(allowNonce("img-src *", "abc")).toBe("img-src *");
  });

  test("a response with a CSP comes back with the nonce allowed", async () => {
    const page = new Response("<html><head></head><body></body></html>", {
      headers: {
        "content-type": "text/html",
        "content-security-policy": "script-src 'self'",
      },
    });
    const injected = await withInspector(page, options);
    expect(injected.headers.get("content-security-policy")).toBe("script-src 'self' 'nonce-abc'");
  });
});
