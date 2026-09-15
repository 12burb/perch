import { describe, expect, test } from "bun:test";
import { SOURCE_ATTRIBUTE, taggable, taggableFile, tagSource } from "../src/tag.ts";

/**
 * Task 2.16 (spec §5.6): the source tag. What matters is not how many elements get one but that
 * nothing else in the file moves — a tag that is missed costs a source link, a tag written into a
 * string costs a build.
 */

describe("tagging elements with where they came from", () => {
  test("a component and a host element each get the file, line and column of their `<`", () => {
    const code = [
      "export const A = () => (",
      '  <div className="x">',
      "    <Button />",
      "  </div>",
      ");",
      "",
    ].join("\n");
    const { code: out, tagged } = tagSource(code, { file: "src/A.tsx" });
    expect(tagged).toBe(2);
    expect(out).toContain(`<div ${SOURCE_ATTRIBUTE}="src/A.tsx:2:3" className="x">`);
    expect(out).toContain(`<Button ${SOURCE_ATTRIBUTE}="src/A.tsx:3:5" />`);
    // The closing tag is left alone, and so is everything that was already there.
    expect(out).toContain("</div>");
    expect(out.replace(new RegExp(` ${SOURCE_ATTRIBUTE}="[^"]*"`, "g"), "")).toBe(code);
  });

  test("nothing inside a string, a comment or a template is touched", () => {
    const code = [
      'const s = "<div>not jsx</div>";',
      "// <div>not jsx</div>",
      "/* <div>not jsx</div> */",
      "const t = `<div>not jsx</div>`;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a template substitution is the subject
      "const u = `${<div>jsx</div>}`;",
      "",
    ].join("\n");
    const { code: out, tagged } = tagSource(code, { file: "a.tsx" });
    // Only the one inside the template's substitution, which is code again.
    expect(tagged).toBe(1);
    expect(out).toContain(`\${<div ${SOURCE_ATTRIBUTE}="a.tsx:5:14">jsx</div>}`);
    expect(out).toContain('const s = "<div>not jsx</div>";');
    expect(out).toContain("// <div>not jsx</div>");
    expect(out).toContain("/* <div>not jsx</div> */");
  });

  test("a comparison is not an element", () => {
    const code = "const ok = a < b && c > d;\nconst g = x <y> 1;\n";
    expect(tagSource(code, { file: "a.tsx" })).toEqual({ code, tagged: 0 });
  });

  test("an element that already says where it came from is left as it is", () => {
    const code = `<div ${SOURCE_ATTRIBUTE}="other.tsx:1:1" />\n`;
    expect(tagSource(code, { file: "a.tsx" }).tagged).toBe(0);
  });

  test("attributes with braces and quotes do not confuse the scan", () => {
    const code = '<Button onClick={() => set({ a: ">" })} title="a > b">go</Button>\n';
    const { code: out, tagged } = tagSource(code, { file: "a.tsx" });
    expect(tagged).toBe(1);
    expect(out.startsWith(`<Button ${SOURCE_ATTRIBUTE}="a.tsx:1:1" onClick=`)).toBe(true);
  });

  test("a fragment has no name to tag", () => {
    expect(tagSource("<>\n  <p>hi</p>\n</>\n", { file: "a.tsx" }).tagged).toBe(1);
  });

  test("which names and which files", () => {
    expect(taggable("div")).toBe(true);
    expect(taggable("Button")).toBe(true);
    expect(taggable("Menu.Item")).toBe(true);
    expect(taggable("notatag")).toBe(false);
    expect(taggableFile("/app/src/A.tsx")).toBe(true);
    expect(taggableFile("/app/src/a.ts")).toBe(false);
    expect(taggableFile("/app/node_modules/x/B.tsx")).toBe(false);
    expect(taggableFile("/app/src/A.tsx?v=1")).toBe(true);
  });
});
