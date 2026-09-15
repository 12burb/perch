import { describe, expect, test } from "bun:test";
import { mask, scanDiff, scanText } from "../src/secrets.ts";

/**
 * Task 2.12 (spec §5.7 "secret scanning on every agent diff before commit"): what it catches, what
 * it lets through, and that it never repeats what it found.
 */

/** A diff the way git writes one, so the scanner is read the thing it will really be given. */
function diff(path: string, ...added: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1,0 +1,2 @@",
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

// Shapes, not secrets: every value here is made up to match a pattern and nothing else.
const PLANTED = `AKIA${"IOSFODNN7QQWERTY"}`;

describe("secret scanning", () => {
  test("a planted key is found, with where it is and nothing more", () => {
    const found = scanDiff(diff("src/config.ts", `const key = "${PLANTED}";`));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "aws.access_key", path: "src/config.ts", line: 1 });
    // The card shows enough to recognise it and not enough to use it.
    expect(found[0]?.sample).not.toContain(PLANTED);
    expect(found[0]?.sample).toContain("…");
  });

  test("the shapes a provider stamps on its own tokens", () => {
    const cases: [string, string][] = [
      ["github.token", `ghp_${"a1B2c3D4e5".repeat(4)}`],
      ["openai.key", `sk-proj-${"Xy9".repeat(12)}`],
      ["anthropic.key", `sk-ant-${"Q7w".repeat(10)}`],
      ["google.key", `AIza${"B".repeat(35)}`],
      ["slack.token", `xoxb-${"1".repeat(12)}-abcdefg`],
      ["stripe.key", `sk_live_${"9z".repeat(10)}`],
      ["npm.token", `npm_${"k".repeat(36)}`],
      ["private_key", "-----BEGIN RSA PRIVATE KEY-----"],
    ];
    for (const [rule, value] of cases) {
      const found = scanDiff(diff("a.ts", `const v = "${value}"`));
      expect(found.map((one) => one.rule)).toContain(rule);
    }
  });

  test("a name that says secret beside a long value, and a password in a URL", () => {
    expect(scanDiff(diff("a.ts", `const API_KEY = "b7Xq20LmZzQw81PaR4tUvY"`))[0]?.rule).toBe(
      "generic.assignment",
    );
    expect(
      scanDiff(diff(".env", "DATABASE_URL=postgres://perch:h8Zq2LmZzQw81Pa@db:5432/perch"))[0]
        ?.rule,
    ).toBe("connection_string");
  });

  test("what it lets through: a line being taken out, a placeholder, an example file", () => {
    // A removal is not a commit of a secret.
    const removing = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +0,0 @@",
      `-const key = "${PLANTED}";`,
    ].join("\n");
    expect(scanDiff(removing)).toEqual([]);
    expect(scanDiff(diff("a.ts", 'const API_KEY = "your-api-key-goes-here"'))).toEqual([]);
    expect(scanDiff(diff("a.ts", 'const API_KEY = "xxxxxxxxxxxxxxxxxxxxxxxx"'))).toEqual([]);
    expect(scanDiff(diff(".env.example", `AWS_ACCESS_KEY_ID=${PLANTED}`))).toEqual([]);
    expect(scanDiff(diff("src/a.ts", "const greeting = 'hello, world'"))).toEqual([]);
    expect(scanDiff(diff("README.md", "Run `bun test` to see it work"))).toEqual([]);
  });

  test("several files in one diff, each with its own line numbers", () => {
    const both = [
      diff("one.ts", "const ok = 1", `const key = "${PLANTED}"`),
      diff("two.ts", `const other = "ghp_${"z9Y8x7W6v5".repeat(4)}"`),
    ].join("\n");
    const found = scanDiff(both);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ path: "one.ts", line: 2 });
    expect(found[1]).toMatchObject({ path: "two.ts", line: 1 });
  });

  test("a whole file can be read the same way, and masking keeps its shape", () => {
    expect(scanText("a.ts", `const key = "${PLANTED}"`)[0]?.path).toBe("a.ts");
    expect(mask("short")).toBe("sh…");
    expect(mask("abcdefghijklmnop")).toBe("abcd…mnop");
  });
});
