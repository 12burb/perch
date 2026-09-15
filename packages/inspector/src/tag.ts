/**
 * Tagging elements with where they came from (spec §5.6 "@perch/inspector dev plugin … tagging
 * data-perch-src=\"src/components/Button.tsx:42:7\""; task 2.16).
 *
 * The transform is a scanner rather than a parser. A parser would mean a JSX toolchain in every
 * project's dev server, and the job is smaller than that: find the `<` that opens a JSX element,
 * and put one attribute after the tag name. Everything ambiguous is left alone — a tag that is not
 * tagged costs the inspector a source link and costs the build nothing, which is the right way for
 * this trade to fail (ADR-0107).
 */

/** Where an element was written, as the attribute carries it. */
export const SOURCE_ATTRIBUTE = "data-perch-src";

export type TagOptions = {
  /** The file's path as the agent should see it: relative to the project, with forward slashes. */
  file: string;
};

export type TagResult = { code: string; tagged: number };

/**
 * The host elements a lowercase tag can be. A lowercase name that is not one of these is left
 * alone, because `a < b` and `x <div` are the same two characters and only one of them is JSX.
 */
const HTML_TAGS = new Set(
  (
    "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas " +
    "caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed " +
    "fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe " +
    "img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol " +
    "optgroup option output p param picture pre progress q rp rt ruby s samp script section select " +
    "slot small source span strong style sub summary sup table tbody td template textarea tfoot th " +
    "thead time title tr track u ul var video wbr svg path circle rect line polygon polyline g defs " +
    "clipPath mask pattern text tspan use"
  ).split(" "),
);

function isNameStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_$.:-]/.test(ch);
}

/** A tag Perch will tag: a component (uppercase or dotted) or a known host element. */
export function taggable(name: string): boolean {
  if (!name) return false;
  const head = name.split(/[.:]/)[0] ?? "";
  if (/^[A-Z]/.test(head)) return true;
  if (name.includes(".")) return true;
  return HTML_TAGS.has(name);
}

type Mode =
  | { kind: "code" }
  | { kind: "line" }
  | { kind: "block" }
  | { kind: "quote"; ch: string }
  | { kind: "template" };

/**
 * One pass over the file. Strings, comments and template literals are skipped so a `<div>` inside
 * one is left where it is; template substitutions are treated as code again, because that is what
 * they are.
 */
export function tagSource(code: string, options: TagOptions): TagResult {
  const file = options.file.replace(/\\/g, "/");
  const out: string[] = [];
  const stack: Mode[] = [{ kind: "code" }];
  let line = 1;
  let column = 1;
  let at = 0;
  let tagged = 0;
  /** Nesting of `${…}` inside template literals, so the closing brace returns to the template. */
  const braces: number[] = [];
  let depth = 0;

  const top = (): Mode => stack[stack.length - 1] ?? { kind: "code" };

  while (at < code.length) {
    const ch = code[at] ?? "";
    const next = code[at + 1] ?? "";
    const mode = top();

    if (mode.kind === "line") {
      if (ch === "\n") stack.pop();
    } else if (mode.kind === "block") {
      if (ch === "*" && next === "/") {
        stack.pop();
        out.push(ch, next);
        advance(2);
        continue;
      }
    } else if (mode.kind === "quote") {
      if (ch === "\\") {
        out.push(ch, next);
        advance(2);
        continue;
      }
      if (ch === mode.ch || ch === "\n") stack.pop();
    } else if (mode.kind === "template") {
      if (ch === "\\") {
        out.push(ch, next);
        advance(2);
        continue;
      }
      if (ch === "`") stack.pop();
      else if (ch === "$" && next === "{") {
        stack.push({ kind: "code" });
        braces.push(depth);
        depth += 1;
        out.push(ch, next);
        advance(2);
        continue;
      }
    } else {
      // code
      if (ch === "/" && next === "/") {
        stack.push({ kind: "line" });
      } else if (ch === "/" && next === "*") {
        stack.push({ kind: "block" });
        out.push(ch, next);
        advance(2);
        continue;
      } else if (ch === '"' || ch === "'") {
        stack.push({ kind: "quote", ch });
      } else if (ch === "`") {
        stack.push({ kind: "template" });
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (stack.length > 1 && braces.length > 0 && braces[braces.length - 1] === depth) {
          braces.pop();
          stack.pop();
        }
      } else if (ch === "<" && isNameStart(next)) {
        const name = readName(code, at + 1);
        if (taggable(name)) {
          const after = at + 1 + name.length;
          const attributes = readAttributes(code, after);
          if (attributes !== null && !attributes.has) {
            out.push(code.slice(at, after));
            out.push(` ${SOURCE_ATTRIBUTE}="${file}:${line}:${column}"`);
            tagged += 1;
            advanceOver(code.slice(at, after));
            continue;
          }
        }
      }
    }

    out.push(ch);
    advance(1);
  }

  return { code: out.join(""), tagged };

  function advance(by: number): void {
    for (let i = 0; i < by; i++) {
      if (code[at] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      at += 1;
    }
  }

  function advanceOver(text: string): void {
    advance(text.length);
  }
}

function readName(code: string, from: number): string {
  let to = from;
  while (to < code.length && isNameChar(code[to] ?? "")) to += 1;
  return code.slice(from, to);
}

/**
 * Whether what follows a tag name really is an opening element, and whether it already says where
 * it came from. Null means "not a tag Perch understands", which is always safe: nothing is written.
 */
function readAttributes(code: string, from: number): { has: boolean } | null {
  let at = from;
  let has = false;
  let guard = 0;
  while (at < code.length && guard < 20_000) {
    guard += 1;
    const ch = code[at] ?? "";
    if (ch === ">") return { has };
    if (ch === "/" && code[at + 1] === ">") return { has };
    if (ch === '"' || ch === "'") {
      const end = code.indexOf(ch, at + 1);
      if (end < 0) return null;
      at = end + 1;
      continue;
    }
    if (ch === "{") {
      // An expression attribute: skip to its matching brace, strings and all.
      const end = matchBrace(code, at);
      if (end < 0) return null;
      at = end + 1;
      continue;
    }
    if (ch === "<") return null;
    if (code.startsWith(SOURCE_ATTRIBUTE, at)) has = true;
    at += 1;
  }
  return null;
}

/** The index of the `}` closing the `{` at `from`, or -1. */
function matchBrace(code: string, from: number): number {
  let depth = 0;
  for (let at = from; at < code.length; at++) {
    const ch = code[at] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = code.indexOf(ch, at + 1);
      if (end < 0) return -1;
      at = end;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** Whether this file is one the transform should touch at all. */
export function taggableFile(id: string): boolean {
  const path = id.split("?")[0] ?? "";
  if (/\/node_modules\//.test(path)) return false;
  return /\.(jsx|tsx)$/.test(path);
}
