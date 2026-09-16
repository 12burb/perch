/**
 * Writing a tweak back to source (spec §5.6 "Direct tweaks (Phase 3): edit text, classes, common
 * CSS in the panel → applied instantly → written to source via a deterministic apply_element_edit
 * tool → diff card"; task 3.21).
 *
 * Deterministic is the word that matters. The panel already knows exactly which element was
 * changed and exactly where it was written — `data-perch-src` carries `file:line:column` for the
 * `<` that opens it (task 2.16) — so turning that into an edit needs no model and should never
 * guess. Given a file and that position, this finds the opening tag, and changes the one attribute
 * or the one piece of text it was asked to.
 *
 * It refuses more than it attempts, on purpose. `className={cn(big, small)}` is not a string this
 * can rewrite, and an element whose children are anything but plain text has no "the text" to
 * replace. A refusal with a reason is a thing the panel can show and an agent can work around; a
 * guess is a wrong edit in somebody's repository.
 */

/** What to change about one element. Everything absent is left alone. */
export type ElementEdit = {
  /** The whole class list, as one string. */
  className?: string;
  /** The element's text, when its children are one piece of text and nothing else. */
  text?: string;
};

export type EditRefusal = { ok: false; reason: string };
export type EditApplied = { ok: true; code: string; changed: ("className" | "text")[] };
export type EditResult = EditApplied | EditRefusal;

/** Where an element was written: 1-based line, 1-based column of its `<`. */
export type ElementAt = { line: number; column: number };

/** `src/app.tsx:42:7` as the attribute carries it, or null when it is not one. */
export function parseSource(value: string): { file: string; at: ElementAt } | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(value.trim());
  const file = match?.[1];
  if (!file) return null;
  return { file, at: { line: Number(match[2]), column: Number(match[3]) } };
}

function offsetOf(code: string, at: ElementAt): number | null {
  if (at.line < 1 || at.column < 1) return null;
  let line = 1;
  let index = 0;
  while (line < at.line) {
    const next = code.indexOf("\n", index);
    if (next === -1) return null;
    index = next + 1;
    line += 1;
  }
  const offset = index + at.column - 1;
  return offset < code.length ? offset : null;
}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_$.:-]/.test(ch);
}

function readName(code: string, from: number): string {
  if (!isNameStart(code[from] ?? "")) return "";
  let at = from + 1;
  while (at < code.length && isNameChar(code[at] ?? "")) at += 1;
  return code.slice(from, at);
}

type Attribute = {
  name: string;
  /** The value's span, inside the quotes; null for a bare attribute or an expression. */
  value: { start: number; end: number } | null;
  /** `foo={bar}` — a value this cannot rewrite. */
  expression: boolean;
};

type OpeningTag = {
  name: string;
  /** Just past the tag name. */
  afterName: number;
  /** The `>` that ends it. */
  end: number;
  selfClosing: boolean;
  attributes: Attribute[];
};

/**
 * The opening tag at `start`, read the way the tagger reads one: a scanner that respects quotes
 * and braces, and gives up rather than guessing when it meets something it does not understand.
 */
function readOpeningTag(code: string, start: number): OpeningTag | null {
  if (code[start] !== "<") return null;
  const name = readName(code, start + 1);
  if (!name) return null;
  const afterName = start + 1 + name.length;
  const attributes: Attribute[] = [];

  let at = afterName;
  while (at < code.length) {
    const ch = code[at] ?? "";
    if (ch === ">") {
      return { name, afterName, end: at, selfClosing: code[at - 1] === "/", attributes };
    }
    if (/\s/.test(ch)) {
      at += 1;
      continue;
    }
    if (ch === "/") {
      at += 1;
      continue;
    }
    if (ch === "{") {
      // A spread, or an attribute-position expression. Skip it whole; it is nobody's className.
      let depth = 0;
      while (at < code.length) {
        const inner = code[at] ?? "";
        if (inner === "{") depth += 1;
        else if (inner === "}") {
          depth -= 1;
          if (depth === 0) {
            at += 1;
            break;
          }
        }
        at += 1;
      }
      if (depth !== 0) return null;
      continue;
    }
    if (!isNameStart(ch)) return null;

    const attribute = readName(code, at);
    at += attribute.length;
    while (at < code.length && /\s/.test(code[at] ?? "")) at += 1;
    if (code[at] !== "=") {
      attributes.push({ name: attribute, value: null, expression: false });
      continue;
    }
    at += 1;
    while (at < code.length && /\s/.test(code[at] ?? "")) at += 1;

    const quote = code[at] ?? "";
    if (quote === '"' || quote === "'") {
      const close = code.indexOf(quote, at + 1);
      if (close === -1) return null;
      attributes.push({ name: attribute, value: { start: at + 1, end: close }, expression: false });
      at = close + 1;
      continue;
    }
    if (quote === "{") {
      let depth = 0;
      const from = at;
      while (at < code.length) {
        const inner = code[at] ?? "";
        if (inner === "{") depth += 1;
        else if (inner === "}") {
          depth -= 1;
          if (depth === 0) {
            at += 1;
            break;
          }
        } else if (inner === '"' || inner === "'" || inner === "`") {
          const close = code.indexOf(inner, at + 1);
          if (close === -1) return null;
          at = close;
        }
        at += 1;
      }
      if (depth !== 0) return null;
      attributes.push({ name: attribute, value: { start: from, end: at }, expression: true });
      continue;
    }
    return null;
  }
  return null;
}

/** The class attribute this file uses, whichever of the two it wrote. */
function classAttribute(tag: OpeningTag): Attribute | undefined {
  return tag.attributes.find((one) => one.name === "className" || one.name === "class");
}

/**
 * The element's own text, when it has exactly that. Anything else — a child element, an
 * expression, a fragment — is refused, because there is no one string to replace.
 */
function textSpan(code: string, tag: OpeningTag): { start: number; end: number } | EditRefusal {
  if (tag.selfClosing) {
    return { ok: false, reason: `<${tag.name} /> has no text to change` };
  }
  const start = tag.end + 1;
  const next = code.indexOf("<", start);
  if (next === -1) return { ok: false, reason: `<${tag.name}> is never closed` };
  const closing = `</${tag.name}`;
  if (!code.startsWith(closing, next)) {
    return {
      ok: false,
      reason: `<${tag.name}> holds more than text, so there is no one piece of text to change`,
    };
  }
  const body = code.slice(start, next);
  if (body.includes("{")) {
    return {
      ok: false,
      reason: `<${tag.name}>'s text is an expression, so it cannot be rewritten as a string`,
    };
  }
  // The words, not the whitespace around them. An element written over three lines keeps its
  // indentation: JSX would collapse it either way, and reflowing somebody's file to change a
  // word is a rude diff.
  const lead = body.length - body.trimStart().length;
  const trail = body.length - body.trimEnd().length;
  return { start: start + lead, end: next - trail };
}

/**
 * One element's text and classes, rewritten in place. Returns the whole file, or a reason it will
 * not touch it.
 */
export function applyElementEdit(code: string, at: ElementAt, edit: ElementEdit): EditResult {
  if (edit.className === undefined && edit.text === undefined) {
    return { ok: false, reason: "nothing to change" };
  }
  const start = offsetOf(code, at);
  if (start === null) return { ok: false, reason: "that place is not in this file any more" };
  const tag = readOpeningTag(code, start);
  if (!tag) {
    return { ok: false, reason: "that place is not an element any more; the file has moved on" };
  }

  // Every edit is a span and its replacement, applied from the end so earlier offsets keep
  // meaning. Two edits on one element never overlap: one is inside the tag, the other after it.
  const edits: { start: number; end: number; text: string }[] = [];
  const changed: ("className" | "text")[] = [];

  if (edit.className !== undefined) {
    const attribute = classAttribute(tag);
    if (attribute?.expression) {
      return {
        ok: false,
        reason: `${attribute.name} here is an expression, not a list of classes this can rewrite`,
      };
    }
    if (edit.className.includes('"')) {
      return { ok: false, reason: "a class list cannot contain a double quote" };
    }
    if (attribute?.value) {
      edits.push({ start: attribute.value.start, end: attribute.value.end, text: edit.className });
    } else if (attribute) {
      return { ok: false, reason: `${attribute.name} here has no value to change` };
    } else {
      const name = /^[a-z]/.test(tag.name) ? "className" : "className";
      edits.push({
        start: tag.afterName,
        end: tag.afterName,
        text: ` ${name}="${edit.className}"`,
      });
    }
    changed.push("className");
  }

  if (edit.text !== undefined) {
    const span = textSpan(code, tag);
    if ("ok" in span) return span;
    if (edit.text.includes("<") || edit.text.includes("{")) {
      return { ok: false, reason: "text cannot contain < or {, which would be markup" };
    }
    edits.push({ start: span.start, end: span.end, text: edit.text });
    changed.push("text");
  }

  let out = code;
  for (const one of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, one.start) + one.text + out.slice(one.end);
  }
  if (out === code) return { ok: false, reason: "that is already what it says" };
  return { ok: true, code: out, changed };
}
