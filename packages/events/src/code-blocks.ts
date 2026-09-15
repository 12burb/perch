/**
 * Fenced code blocks in an agent's reply (tasks 1.13, 1.14): the text splits on ``` fences; a
 * fence's info string may name a language and a file (```ts path=src/a.ts, ```ts:src/a.ts,
 * ```ts title="src/a.ts", or a bare src/a.ts), which Apply writes the block to. Pure string work,
 * so the ui renders with it and the api reads a ⌘K proposal out of a reply with it.
 */
export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string | null; path: string | null; code: string; open: boolean };

const OPEN = /^\s{0,3}(`{3,})(.*)$/;
const CLOSE = /^\s{0,3}(`{3,})\s*$/;

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** The info string's words, with a quoted value ("src/a b.ts") kept whole. */
function tokenize(info: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of info.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** A word that names a file rather than a language: it has a directory or an extension. */
function looksLikePath(token: string): boolean {
  return /[./]/.test(token);
}

/** The language and file named by a fence's info string. */
export function parseFenceInfo(info: string): { lang: string | null; path: string | null } {
  let lang: string | null = null;
  let path: string | null = null;
  for (const [index, token] of tokenize(info).entries()) {
    const named = /^(?:path|file|title|filename)=(.+)$/.exec(token);
    if (named?.[1]) {
      path = unquote(named[1]);
      continue;
    }
    if (index === 0) {
      const colon = token.indexOf(":");
      if (colon > 0) {
        lang = token.slice(0, colon);
        path = unquote(token.slice(colon + 1)) || path;
      } else if (looksLikePath(token)) {
        // A bare file name: the extension is as good a language as any.
        path = token;
        lang = /\.([A-Za-z0-9]+)$/.exec(token)?.[1] ?? null;
      } else {
        lang = token;
      }
      continue;
    }
    if (!path && looksLikePath(token)) path = token;
  }
  return { lang, path };
}

/** Text and code parts in order; a fence still open at the end (a reply mid-stream) is a code part too. */
export function splitCodeBlocks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const lines = text.split("\n");
  let plain: string[] = [];
  /** `ticks` is the opening run: a block closes on a run at least as long, so fences nest. */
  let fence: { lang: string | null; path: string | null; ticks: number; code: string[] } | null =
    null;
  const flushPlain = () => {
    const joined = plain.join("\n");
    if (joined.trim().length > 0 || (parts.length > 0 && joined.length > 0)) {
      parts.push({ kind: "text", text: joined });
    }
    plain = [];
  };
  for (const line of lines) {
    if (fence) {
      const close = CLOSE.exec(line);
      if (close && (close[1] ?? "").length >= fence.ticks) {
        const { lang, path, code } = fence;
        parts.push({ kind: "code", lang, path, code: code.join("\n"), open: false });
        fence = null;
      } else {
        fence.code.push(line);
      }
      continue;
    }
    const open = OPEN.exec(line);
    if (open) {
      flushPlain();
      fence = {
        ...parseFenceInfo(open[2] ?? ""),
        ticks: (open[1] ?? "```").length,
        code: [],
      };
    } else {
      plain.push(line);
    }
  }
  if (fence) {
    const { lang, path, code } = fence;
    parts.push({ kind: "code", lang, path, code: code.join("\n"), open: true });
  } else flushPlain();
  return parts;
}

/**
 * The code a reply proposes: its first complete fenced block, or — when the model answered with
 * bare text — the text itself. Trailing newlines are left to the caller.
 */
export function proposedCode(reply: string): string {
  const parts = splitCodeBlocks(reply);
  const fenced = parts.find((part) => part.kind === "code" && !part.open);
  if (fenced && fenced.kind === "code") return fenced.code;
  const open = parts.find((part) => part.kind === "code");
  if (open && open.kind === "code") return open.code;
  return parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
