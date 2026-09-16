import { describe, expect, test } from "bun:test";
import { applyElementEdit, type ElementAt, parseSource } from "../src/edit.ts";
import { SOURCE_ATTRIBUTE, tagSource } from "../src/tag.ts";

/**
 * Task 3.21: a tweak in the panel, written back to source without a model anywhere near it. What
 * these cover is mostly the refusals — the whole value of a deterministic edit is that it does
 * nothing at all when it is not sure, rather than something plausible.
 */

/** Where the tagger says an element is, which is the only way this is ever called for real. */
function taggedAt(code: string, nth = 0): ElementAt {
  const { code: out } = tagSource(code, { file: "src/app.tsx" });
  const found = [...out.matchAll(new RegExp(`${SOURCE_ATTRIBUTE}="([^"]+)"`, "g"))];
  const value = found[nth]?.[1] ?? "";
  const parsed = parseSource(value);
  if (!parsed) throw new Error(`nothing tagged at ${nth}: ${out}`);
  return parsed.at;
}

describe("parseSource", () => {
  test("a file, a line and a column, and nothing else", () => {
    expect(parseSource("src/app.tsx:42:7")).toEqual({
      file: "src/app.tsx",
      at: { line: 42, column: 7 },
    });
    // A Windows path has its own colon, and the last two are still the ones that count.
    expect(parseSource("C:/w/app.tsx:3:1")?.file).toBe("C:/w/app.tsx");
    expect(parseSource("nonsense")).toBeNull();
    expect(parseSource("")).toBeNull();
  });
});

describe("applyElementEdit (task 3.21)", () => {
  test("the class list of an element that has one", () => {
    const code = `export const A = () => (\n  <div className="p-2 text-sm">hello</div>\n);\n`;
    const result = applyElementEdit(code, taggedAt(code), { className: "p-4 text-md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain('className="p-4 text-md"');
    expect(result.code).toContain(">hello<");
    expect(result.changed).toEqual(["className"]);
  });

  test("a class list on an element that had none", () => {
    const code = `const A = () => <span id="x">hi</span>;\n`;
    const result = applyElementEdit(code, taggedAt(code), { className: "font-bold" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe(`const A = () => <span className="font-bold" id="x">hi</span>;\n`);
  });

  test("the text of an element whose children are text", () => {
    const code = `const A = () => <p className="a">old words</p>;\n`;
    const result = applyElementEdit(code, taggedAt(code), { text: "new words" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe(`const A = () => <p className="a">new words</p>;\n`);
  });

  test("both at once, and the later edit does not move the earlier one", () => {
    const code = `const A = () => <p className="a">old</p>;\n`;
    const result = applyElementEdit(code, taggedAt(code), { className: "b c", text: "new" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe(`const A = () => <p className="b c">new</p>;\n`);
    expect(result.changed.sort()).toEqual(["className", "text"]);
  });

  test("an element written over several lines", () => {
    const code = [
      "const A = () => (",
      "  <button",
      '    type="button"',
      '    className="rounded"',
      "  >",
      "    press",
      "  </button>",
      ");",
      "",
    ].join("\n");
    const result = applyElementEdit(code, taggedAt(code), { className: "rounded border" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain('className="rounded border"');
    expect(result.code).toContain("press");
  });

  test("text over several lines keeps its indentation", () => {
    const code = ["const A = () => (", '  <p className="a">', "    hello", "  </p>", ");", ""].join(
      "\n",
    );
    const result = applyElementEdit(code, taggedAt(code), { text: "hello there" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code.split("\n")).toHaveLength(code.split("\n").length);
    expect(result.code).toContain("    hello there\n");
  });

  test("a component, not just a host element", () => {
    const code = `const A = () => <Card className="p-2">inside</Card>;\n`;
    const result = applyElementEdit(code, taggedAt(code), { text: "outside" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain(">outside<");
  });

  test("it refuses a className that is an expression", () => {
    const code = "const A = () => <div className={cn(a, b)}>hi</div>;\n";
    const result = applyElementEdit(code, taggedAt(code), { className: "p-2" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("expression");
  });

  test("it refuses text when the element holds anything but text", () => {
    const nested = 'const A = () => <div className="a"><b>hi</b></div>;\n';
    const one = applyElementEdit(nested, taggedAt(nested), { text: "no" });
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.reason).toContain("more than text");

    const expression = 'const A = () => <div className="a">{name}</div>;\n';
    const two = applyElementEdit(expression, taggedAt(expression), { text: "no" });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.reason).toContain("expression");
  });

  test("it refuses text on a self-closing element", () => {
    const code = 'const A = () => <img className="a" src="x.png" />;\n';
    const result = applyElementEdit(code, taggedAt(code), { text: "no" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no text");
  });

  test("it refuses a place the file has moved on from", () => {
    const code = "const a = 1;\n";
    const gone = applyElementEdit(code, { line: 9, column: 1 }, { text: "x" });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toContain("not in this file");

    const moved = applyElementEdit(code, { line: 1, column: 1 }, { text: "x" });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.reason).toContain("not an element");
  });

  test("it refuses what would become markup, or a change that is not one", () => {
    const code = 'const A = () => <p className="a">hi</p>;\n';
    const markup = applyElementEdit(code, taggedAt(code), { text: "<b>no</b>" });
    expect(markup.ok).toBe(false);
    if (!markup.ok) expect(markup.reason).toContain("markup");

    const quoted = applyElementEdit(code, taggedAt(code), { className: 'a"b' });
    expect(quoted.ok).toBe(false);

    const same = applyElementEdit(code, taggedAt(code), { text: "hi" });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.reason).toContain("already");

    const nothing = applyElementEdit(code, taggedAt(code), {});
    expect(nothing.ok).toBe(false);
  });

  test("an attribute-position spread is skipped rather than mistaken for one", () => {
    const code = 'const A = () => <div {...rest} className="a">hi</div>;\n';
    const result = applyElementEdit(code, taggedAt(code), { className: "b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain('className="b"');
    expect(result.code).toContain("{...rest}");
  });

  test("the second element on a line is the second element on a line", () => {
    const code = 'const A = () => <div className="a"><span className="b">x</span></div>;\n';
    const result = applyElementEdit(code, taggedAt(code, 1), { text: "y" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain(">y<");
    expect(result.code).toContain('className="b"');
  });
});
