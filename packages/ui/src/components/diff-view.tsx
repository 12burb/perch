/**
 * DiffView (spec §4 "editor and review", task 1.13): files and their hunks with gutter line
 * numbers, add/remove in the two semantic colors, per-hunk Accept/Reject, per-file Accept all /
 * Reject all, and Open. Every hunk is labeled ("Hunk 2 of 3") for screen readers; rows are one
 * flat virtualized list so a long diff stays light.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ExternalLink, X } from "lucide-react";
import { useMemo, useRef } from "react";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";
import { Badge, Button } from "./primitives.tsx";

export type DiffDecisionKind = "accept" | "reject";

export type DiffHunkView = {
  /** 0-based index within the file's patch. */
  index: number;
  /** The `@@ -a,b +c,d @@ …` line. */
  header: string;
  /** Body lines with their prefix (` `, `+`, `-`, `\`). */
  lines: string[];
  decision?: DiffDecisionKind;
};

export type DiffFileView = {
  path: string;
  oldPath?: string;
  status?: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary?: boolean;
  hunks: DiffHunkView[];
};

export type DiffViewProps = {
  files: DiffFileView[];
  /** Answers a hunk; absent: read-only. */
  onDecide?: (path: string, hunk: number, action: DiffDecisionKind) => void;
  /** Answers every open hunk of a file. */
  onDecideFile?: (path: string, action: DiffDecisionKind) => void;
  onOpen?: (path: string) => void;
  /** Disables the buttons while a decision is on its way. */
  busy?: boolean;
  label?: string;
  className?: string;
};

export type DiffLineKind = "context" | "add" | "del" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Body lines with their old and new line numbers, from the hunk header. */
export function hunkLines(header: string, lines: readonly string[]): DiffLine[] {
  const match = HUNK.exec(header);
  let oldNo = match ? Number(match[1]) : 1;
  let newNo = match ? Number(match[3]) : 1;
  const out: DiffLine[] = [];
  for (const raw of lines) {
    const prefix = raw.charAt(0);
    const text = raw.slice(1);
    if (prefix === "+") out.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
    else if (prefix === "-") out.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
    else if (prefix === "\\") out.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    else out.push({ kind: "context", text, oldNo: oldNo++, newNo: newNo++ });
  }
  return out;
}

type Row =
  | { kind: "file"; key: string; file: DiffFileView }
  | {
      kind: "hunk";
      key: string;
      file: DiffFileView;
      hunk: DiffHunkView;
      ordinal: number;
      total: number;
    }
  | { kind: "line"; key: string; line: DiffLine; decision?: DiffDecisionKind };

function rowsOf(files: DiffFileView[]): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    rows.push({ kind: "file", key: `f:${file.path}`, file });
    file.hunks.forEach((hunk, i) => {
      rows.push({
        kind: "hunk",
        key: `h:${file.path}:${hunk.index}`,
        file,
        hunk,
        ordinal: i + 1,
        total: file.hunks.length,
      });
      hunkLines(hunk.header, hunk.lines).forEach((line, j) => {
        rows.push({
          kind: "line",
          key: `l:${file.path}:${hunk.index}:${j}`,
          line,
          ...(hunk.decision ? { decision: hunk.decision } : {}),
        });
      });
    });
  }
  return rows;
}

export function DiffView(props: DiffViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => rowsOf(props.files), [props.files]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === "line" ? 22 : 40),
    overscan: 20,
    getItemKey: (index) => rows[index]?.key ?? index,
  });
  const label = props.label ?? t("diff.label");
  if (props.files.length === 0) {
    return (
      <section
        aria-label={label}
        className={cn("px-3 py-6", props.className)}
        data-testid="diff-view"
      >
        <p className="text-center text-fg-subtle text-sm">{t("diff.empty")}</p>
      </section>
    );
  }
  return (
    <section
      ref={parentRef}
      aria-label={label}
      className={cn("min-h-0 flex-1 overflow-auto", props.className)}
      data-testid="diff-view"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const row = rows[virtual.index];
          if (!row) return null;
          return (
            <div
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtual.start}px)` }}
            >
              <DiffRow row={row} {...props} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DiffRow(props: { row: Row } & DiffViewProps) {
  const { row } = props;
  switch (row.kind) {
    case "file": {
      const { file } = row;
      const open = file.hunks.filter((h) => !h.decision).length;
      return (
        <div
          className="flex flex-wrap items-center gap-2 border-border border-y bg-surface px-3 py-1.5"
          data-testid="diff-file"
        >
          <h3 className="min-w-0 flex-1 truncate font-mono text-sm">
            {file.oldPath ? `${file.oldPath} → ` : ""}
            {file.path}
          </h3>
          {file.status ? <Badge>{t(`diff.status.${file.status}`)}</Badge> : null}
          <span className="text-xs">
            <span className="text-success">+{file.additions}</span>{" "}
            <span className="text-danger">-{file.deletions}</span>
          </span>
          {file.binary ? <span className="text-fg-muted text-xs">{t("diff.binary")}</span> : null}
          {props.onOpen ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("diff.open", { path: file.path })}
              onClick={() => props.onOpen?.(file.path)}
            >
              <ExternalLink aria-hidden className="size-4" />
            </Button>
          ) : null}
          {props.onDecideFile && open > 0 ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={props.busy}
                aria-label={t("diff.acceptAll", { path: file.path })}
                onClick={() => props.onDecideFile?.(file.path, "accept")}
              >
                {t("diff.acceptAllShort")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy}
                aria-label={t("diff.rejectAll", { path: file.path })}
                onClick={() => props.onDecideFile?.(file.path, "reject")}
              >
                {t("diff.rejectAllShort")}
              </Button>
            </>
          ) : null}
        </div>
      );
    }
    case "hunk": {
      const { file, hunk, ordinal, total } = row;
      const title = t("diff.hunk", { n: String(ordinal), total: String(total) });
      return (
        <div
          className="flex items-center gap-2 bg-raised px-3 py-1 text-fg-muted text-xs"
          data-testid="diff-hunk"
          data-decision={hunk.decision ?? "open"}
        >
          <h4 className="min-w-0 flex-1 truncate font-mono">
            <span className="mr-2 font-sans">{title}</span>
            <span aria-hidden>{hunk.header}</span>
          </h4>
          {hunk.decision ? (
            <Badge tone={hunk.decision === "accept" ? "success" : "danger"}>
              {t(hunk.decision === "accept" ? "diff.accepted" : "diff.rejected")}
            </Badge>
          ) : props.onDecide ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy}
                aria-label={t("diff.accept", { n: String(ordinal), path: file.path })}
                onClick={() => props.onDecide?.(file.path, hunk.index, "accept")}
              >
                <Check aria-hidden className="size-4 text-success" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy}
                aria-label={t("diff.reject", { n: String(ordinal), path: file.path })}
                onClick={() => props.onDecide?.(file.path, hunk.index, "reject")}
              >
                <X aria-hidden className="size-4 text-danger" />
              </Button>
            </>
          ) : null}
        </div>
      );
    }
    case "line": {
      const { line } = row;
      // Numbers on changed lines take the line's own color: the muted tone falls short of AA on the soft backgrounds.
      const gutter = line.kind === "add" || line.kind === "del" ? "" : "text-fg-subtle";
      return (
        <div
          className={cn(
            "flex whitespace-pre font-mono text-xs leading-[22px]",
            line.kind === "add" && "bg-success-soft text-success",
            line.kind === "del" && "bg-danger-soft text-danger",
            line.kind === "meta" && "text-fg-subtle",
            row.decision === "reject" && "opacity-60 line-through",
          )}
          data-testid="diff-line"
          data-kind={line.kind}
        >
          <span aria-hidden className={cn("w-10 shrink-0 select-none pr-1 text-right", gutter)}>
            {line.oldNo ?? ""}
          </span>
          <span aria-hidden className={cn("w-10 shrink-0 select-none pr-1 text-right", gutter)}>
            {line.newNo ?? ""}
          </span>
          <span aria-hidden className="w-4 shrink-0 select-none text-center">
            {line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}
          </span>
          {line.kind === "add" || line.kind === "del" ? (
            <span className="sr-only">
              {t(line.kind === "add" ? "diff.added" : "diff.removed")}{" "}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 overflow-x-auto pr-3">{line.text}</span>
        </div>
      );
    }
    default:
      return null;
  }
}
