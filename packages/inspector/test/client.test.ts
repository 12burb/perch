import { describe, expect, test } from "bun:test";
import { CLIENT_MESSAGE, HOST_MESSAGE, INSPECTOR_CLIENT, inspectorClient } from "../src/client.ts";

/**
 * Task 2.16 (spec §5.6): the injected client. It is serialized rather than bundled, so what a test
 * can hold it to is that the serialization really produced a callable script, that the nonce and
 * the pane's origin are in it, and that it stays inside §5.6's size.
 */

describe("the injected client", () => {
  test("is one self-contained call, under the 15 KB §5.6 allows", () => {
    const source = inspectorClient("nonce-1", "https://perch.example");
    expect(source.startsWith("(function")).toBe(true);
    expect(source.trimEnd().endsWith(");")).toBe(true);
    expect(source.length).toBeLessThan(15 * 1024);
    // It talks to one origin, signed with one nonce, and names both protocols.
    expect(source).toContain("nonce-1");
    expect(source).toContain("https://perch.example");
    expect(source).toContain(CLIENT_MESSAGE);
    expect(source).toContain(HOST_MESSAGE);
    // Nothing outside itself: no import survived into the script.
    expect(source).not.toContain("import ");
    expect(source).not.toContain("require(");
  });

  test("neither value can break out of the call", () => {
    const source = inspectorClient('x");alert(1);("', "javascript:alert(1)");
    expect(source).not.toContain("alert(1)");
    expect(INSPECTOR_CLIENT).toContain("{{nonce}}");
  });

  test("it parses as a script", () => {
    // Compiling it is the only honest proof that the serialization produced valid JavaScript.
    expect(() => new Function(inspectorClient("n", "https://p.test"))).not.toThrow();
  });
});
