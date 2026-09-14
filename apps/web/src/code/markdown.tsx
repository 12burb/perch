import type { SyntaxNode } from "@lezer/common";
import { GFM, parser } from "@lezer/markdown";
import { type ReactNode, useMemo } from "react";

/**
 * Markdown preview (spec §5.1) rendered from the @lezer/markdown tree straight into React elements:
 * no HTML pass-through, so a repository's README cannot script the app. Covers CommonMark plus
 * GFM tables, strikethrough, and task lists; raw HTML blocks show as text.
 */

const gfm = parser.configure(GFM);

const MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "ListMark",
  "QuoteMark",
  "TableDelimiter",
  "StrikethroughMark",
  "TaskMarker",
  "CodeInfo",
  "URL",
  "LinkTitle",
  "LinkLabel",
  "HardBreak",
]);

export type MarkdownProps = {
  source: string;
  /** Turns a relative image path into a URL the browser can load (project files). */
  resolveImage?: (src: string) => string;
  className?: string;
};

function text(source: string, node: SyntaxNode): string {
  return source.slice(node.from, node.to);
}

function childOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name === type) return child;
  }
  return null;
}

function safeHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|#|\/|\.)/i.test(trimmed)) return trimmed;
  return undefined;
}

function renderChildren(
  source: string,
  node: SyntaxNode,
  ctx: { resolveImage?: (src: string) => string; key: { n: number } },
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > cursor) out.push(source.slice(cursor, child.from));
    if (child.type.name === "HardBreak") out.push(<br key={ctx.key.n++} />);
    else if (!MARKS.has(child.type.name)) out.push(render(source, child, ctx));
    cursor = child.to;
  }
  if (node.to > cursor) out.push(source.slice(cursor, node.to));
  return out;
}

function render(
  source: string,
  node: SyntaxNode,
  ctx: { resolveImage?: (src: string) => string; key: { n: number } },
): ReactNode {
  const key = ctx.key.n++;
  const name = node.type.name;
  const inner = () => renderChildren(source, node, ctx);
  switch (name) {
    case "Document":
      return <div key={key}>{inner()}</div>;
    case "Paragraph":
      return <p key={key}>{inner()}</p>;
    case "ATXHeading1":
    case "SetextHeading1":
      return <h1 key={key}>{inner()}</h1>;
    case "ATXHeading2":
    case "SetextHeading2":
      return <h2 key={key}>{inner()}</h2>;
    case "ATXHeading3":
      return <h3 key={key}>{inner()}</h3>;
    case "ATXHeading4":
      return <h4 key={key}>{inner()}</h4>;
    case "ATXHeading5":
      return <h5 key={key}>{inner()}</h5>;
    case "ATXHeading6":
      return <h6 key={key}>{inner()}</h6>;
    case "Blockquote":
      return <blockquote key={key}>{inner()}</blockquote>;
    case "BulletList":
      return <ul key={key}>{inner()}</ul>;
    case "OrderedList":
      return <ol key={key}>{inner()}</ol>;
    case "ListItem": {
      const task = childOfType(node, "Task");
      return (
        <li key={key} className={task ? "list-none" : undefined}>
          {inner()}
        </li>
      );
    }
    case "Task": {
      const marker = childOfType(node, "TaskMarker");
      const checked = marker ? /x/i.test(text(source, marker)) : false;
      return (
        <span key={key}>
          <input type="checkbox" checked={checked} readOnly aria-label="task" className="mr-1" />
          {inner()}
        </span>
      );
    }
    case "HorizontalRule":
      return <hr key={key} />;
    case "FencedCode":
    case "CodeBlock": {
      const body = childOfType(node, "CodeText");
      const info = childOfType(node, "CodeInfo");
      const lang = info ? text(source, info).trim() : "";
      return (
        <pre key={key} data-lang={lang || undefined}>
          <code>{body ? text(source, body) : ""}</code>
        </pre>
      );
    }
    case "InlineCode":
      return <code key={key}>{inner()}</code>;
    case "Emphasis":
      return <em key={key}>{inner()}</em>;
    case "StrongEmphasis":
      return <strong key={key}>{inner()}</strong>;
    case "Strikethrough":
      return <del key={key}>{inner()}</del>;
    case "Link": {
      const url = childOfType(node, "URL");
      const href = url ? safeHref(text(source, url)) : undefined;
      return href ? (
        <a
          key={key}
          href={href}
          rel="noreferrer noopener"
          target={/^https?:/i.test(href) ? "_blank" : undefined}
        >
          {inner()}
        </a>
      ) : (
        <span key={key}>{inner()}</span>
      );
    }
    case "Image": {
      const url = childOfType(node, "URL");
      const raw = url ? text(source, url).trim() : "";
      const alt = renderChildren(source, node, ctx)
        .map((part) => (typeof part === "string" ? part : ""))
        .join("")
        .replace(/^!?\[|\]$/g, "");
      const src = /^https?:/i.test(raw) ? raw : ctx.resolveImage ? ctx.resolveImage(raw) : "";
      return src ? (
        <img key={key} src={src} alt={alt} className="max-w-full" />
      ) : (
        <span key={key}>{alt}</span>
      );
    }
    case "Table":
      return (
        <table key={key}>
          <tbody>{inner()}</tbody>
        </table>
      );
    case "TableHeader":
      return <tr key={key}>{renderCells(source, node, ctx, "th")}</tr>;
    case "TableRow":
      return <tr key={key}>{renderCells(source, node, ctx, "td")}</tr>;
    case "TableCell":
      return <td key={key}>{inner()}</td>;
    case "Autolink": {
      const href = safeHref(text(source, node).replace(/^<|>$/g, ""));
      return href ? (
        <a key={key} href={href} rel="noreferrer noopener" target="_blank">
          {text(source, node)}
        </a>
      ) : (
        <span key={key}>{text(source, node)}</span>
      );
    }
    case "HTMLBlock":
    case "HTMLTag":
    case "CommentBlock":
    case "ProcessingInstructionBlock":
      return <span key={key}>{text(source, node)}</span>;
    default:
      return <span key={key}>{inner()}</span>;
  }
}

function renderCells(
  source: string,
  row: SyntaxNode,
  ctx: { resolveImage?: (src: string) => string; key: { n: number } },
  tag: "th" | "td",
): ReactNode[] {
  const cells: ReactNode[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.type.name !== "TableCell") continue;
    const Tag = tag;
    cells.push(<Tag key={ctx.key.n++}>{renderChildren(source, child, ctx)}</Tag>);
  }
  return cells;
}

export function renderMarkdown(source: string, resolveImage?: (src: string) => string): ReactNode {
  const tree = gfm.parse(source);
  const ctx = resolveImage ? { resolveImage, key: { n: 0 } } : { key: { n: 0 } };
  return render(source, tree.topNode, ctx);
}

export function Markdown(props: MarkdownProps) {
  const rendered = useMemo(
    () => renderMarkdown(props.source, props.resolveImage),
    [props.source, props.resolveImage],
  );
  return (
    <div className={props.className ?? "prose-perch"} data-testid="markdown-preview">
      {rendered}
    </div>
  );
}
