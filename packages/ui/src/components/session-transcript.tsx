/**
 * The session pane's pieces (spec §4 SessionTranscript, ToolCard, PermissionPrompt; §5.1; task
 * 1.12): a virtualized transcript of turns, streamed text, collapsed tool cards with their output
 * and diffs, permission prompts (Allow once / Always this session / Deny), and errors. The pane
 * itself (composer, usage footer, list) lives in the app; these are the accessible building blocks.
 */
import "../i18n/code.ts";
import { splitCodeBlocks } from "@perch/events/code-blocks";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  ShieldQuestion,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";
import { Badge, Button } from "./primitives.tsx";

export type TranscriptDiff = {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: "added" | "modified" | "deleted" | "renamed";
};

export type PermissionAnswerKind = "allow" | "always" | "deny";

/** A fenced code block in a reply, with the file its info string named (task 1.13 Apply). */
export type CodeBlock = { code: string; lang: string | null; path: string | null };

export type TranscriptItem =
  | { kind: "turn"; id: string; text: string; mode: "plan" | "build"; turn: number }
  | { kind: "text"; id: string; text: string; streaming?: boolean }
  | { kind: "restore"; id: string; turn: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      status: "running" | "done" | "error";
      output?: string;
      diff?: TranscriptDiff[];
    }
  | { kind: "permission"; id: string; tool: string; args: unknown; answer?: PermissionAnswerKind }
  | { kind: "error"; id: string; message: string };

export type SessionStatusKind = "idle" | "running" | "needs_you" | "error" | "ended";

function short(value: unknown, max = 96): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === undefined || value === null) text = "";
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** A tool call, collapsed to one line until opened. */
export function ToolCard(props: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { item } = props;
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const statusKey =
    item.status === "running"
      ? "session.tool.running"
      : item.status === "error"
        ? "session.tool.failed"
        : "session.tool.done";
  const summary = short(item.args);
  return (
    <div
      className={cn("rounded-md border border-border bg-surface text-sm", props.className)}
      data-testid="tool-card"
      data-status={item.status}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-raised"
        aria-expanded={open}
        aria-label={t("session.tool.toggle", { name: item.name })}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-4 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-4 shrink-0" />
        )}
        <Wrench aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <span className="font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{summary}</span>
        <Badge tone={item.status === "error" ? "danger" : "neutral"}>{t(statusKey)}</Badge>
      </button>
      {open ? (
        <div className="space-y-2 border-border border-t px-2 py-2">
          <div>
            <p className="text-fg-muted text-xs">{t("session.tool.args")}</p>
            <pre className="max-h-48 overflow-auto rounded bg-raised p-2 font-mono text-xs">
              {pretty(item.args)}
            </pre>
          </div>
          {item.output ? (
            <div>
              <p className="text-fg-muted text-xs">{t("session.tool.output")}</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-raised p-2 font-mono text-xs">
                {item.output}
              </pre>
            </div>
          ) : null}
          {item.diff?.map((diff) => (
            <div key={diff.path} data-testid="tool-diff">
              <p className="text-xs">
                <span className="font-mono">{diff.path}</span>{" "}
                <span className="text-success">+{diff.additions}</span>{" "}
                <span className="text-danger">-{diff.deletions}</span>
              </p>
              {diff.patch ? (
                <pre className="max-h-64 overflow-auto rounded bg-raised p-2 font-mono text-xs">
                  {diff.patch}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A permission request with the three answers of spec §5.1. */
export function PermissionPrompt(props: {
  item: Extract<TranscriptItem, { kind: "permission" }>;
  onAnswer?: (id: string, answer: PermissionAnswerKind) => void;
  className?: string;
}) {
  const { item } = props;
  const answered = item.answer !== undefined;
  return (
    <section
      className={cn(
        "rounded-md border border-warning/60 bg-warning/10 p-3 text-sm",
        props.className,
      )}
      aria-label={t("session.permission.label", { tool: item.tool })}
      data-testid="permission-prompt"
    >
      <p className="flex items-center gap-2 font-medium">
        <ShieldQuestion aria-hidden className="size-4" />
        {t("session.permission.title", { tool: item.tool })}
      </p>
      <pre className="mt-1 max-h-40 overflow-auto rounded bg-raised p-2 font-mono text-xs">
        {pretty(item.args)}
      </pre>
      {answered ? (
        <p className="mt-2 text-fg-muted">
          {t(`session.permission.answered.${item.answer ?? "deny"}`)}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => props.onAnswer?.(item.id, "allow")}>
            {t("session.permission.allow")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => props.onAnswer?.(item.id, "always")}>
            {t("session.permission.always")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onAnswer?.(item.id, "deny")}>
            {t("session.permission.deny")}
          </Button>
        </div>
      )}
    </section>
  );
}

export type SessionTranscriptProps = {
  items: TranscriptItem[];
  status: SessionStatusKind;
  onPermission?: (id: string, answer: PermissionAnswerKind) => void;
  /** Puts the project back to before a turn (task 1.13); absent: no restore buttons. */
  onRestore?: (turn: number) => void;
  /** Writes a reply's code block to a file (task 1.13); absent: blocks are read-only. */
  onApply?: (block: CodeBlock) => void;
  label?: string;
  className?: string;
  /** Keeps the end in view as items arrive while the reader is near it (default true). */
  follow?: boolean;
};

const NEAR_BOTTOM_PX = 80;

/** The transcript: a live region of turns, replies, tool cards, and prompts, virtualized. */
export function SessionTranscript(props: SessionTranscriptProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const { items } = props;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
    getItemKey: (index) => items[index]?.id ?? index,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const last = items.at(-1);
  // Rows measure themselves after they mount, so the end moves; total size is a dependency too.
  const totalSize = virtualizer.getTotalSize();
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the end whenever the transcript grows, its last item changes, or rows finish measuring
  useEffect(() => {
    if (props.follow === false || !nearBottom.current || items.length === 0) return;
    virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    // We scrolled to the end on purpose: stay in follow mode until the reader scrolls away.
    nearBottom.current = true;
  }, [items.length, last?.kind === "text" ? last.text.length : 0, totalSize, props.follow]);

  return (
    <div
      ref={parentRef}
      className={cn("min-h-0 flex-1 overflow-auto px-3 py-2", props.className)}
      role="log"
      aria-live="polite"
      aria-busy={props.status === "running"}
      aria-label={props.label ?? t("session.transcript")}
      data-testid="session-transcript"
    >
      {items.length === 0 ? (
        <p className="py-6 text-center text-fg-subtle text-sm">{t("session.empty")}</p>
      ) : (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            if (!item) return null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute top-0 left-0 w-full pb-2"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <TranscriptRow
                  item={item}
                  onPermission={props.onPermission}
                  onRestore={props.onRestore}
                  onApply={props.onApply}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TranscriptRow(props: {
  item: TranscriptItem;
  onPermission?: (id: string, answer: PermissionAnswerKind) => void;
  onRestore?: (turn: number) => void;
  onApply?: (block: CodeBlock) => void;
}) {
  const { item } = props;
  switch (item.kind) {
    case "turn":
      return (
        <article
          className="ml-8 rounded-md bg-accent-soft px-3 py-2 text-sm"
          aria-label={t("session.turnNumber", { turn: String(item.turn) })}
          data-testid="transcript-turn"
        >
          <p className="whitespace-pre-wrap">{item.text}</p>
          <p className="mt-1 flex items-center gap-2 text-fg-muted text-xs">
            <span>{t(`session.mode.${item.mode}`)}</span>
            {props.onRestore ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-1.5"
                aria-label={t("session.restoreTo", { turn: String(item.turn) })}
                onClick={() => props.onRestore?.(item.turn)}
              >
                <History aria-hidden className="size-3.5" />
              </Button>
            ) : null}
          </p>
        </article>
      );
    case "text":
      return (
        <article
          className="mr-8 px-1 py-1 text-sm"
          aria-label={t("session.agent")}
          data-testid="transcript-text"
        >
          <ReplyText text={item.text} onApply={props.onApply} />
          {item.streaming ? (
            <span aria-hidden className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-fg-muted" />
          ) : null}
        </article>
      );
    case "restore":
      return (
        <p
          role="status"
          className="mx-8 flex items-center justify-center gap-2 rounded-md border border-border border-dashed px-3 py-1 text-fg-muted text-xs"
          data-testid="transcript-restore"
        >
          <History aria-hidden className="size-3.5" />
          {t("session.restored", { turn: String(item.turn) })}
        </p>
      );
    case "tool":
      return <ToolCard item={item} className="mr-8" />;
    case "permission":
      return <PermissionPrompt item={item} onAnswer={props.onPermission} className="mr-8" />;
    case "error":
      return (
        <p
          role="alert"
          className="mr-8 flex items-center gap-2 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-sm"
          data-testid="transcript-error"
        >
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          {item.message}
        </p>
      );
    default:
      return null;
  }
}

/** A reply's text with its fenced code blocks as blocks, each with Apply when the app offers it. */
function ReplyText(props: { text: string; onApply?: (block: CodeBlock) => void }) {
  const parts = splitCodeBlocks(props.text);
  if (parts.length === 1 && parts[0]?.kind === "text") {
    return <span className="whitespace-pre-wrap">{parts[0].text}</span>;
  }
  // Keys: where each part starts in the text, so a reply that grows keeps its earlier blocks.
  let offset = 0;
  const keyed = parts.map((part) => {
    const key = `${part.kind}@${offset}`;
    offset += (part.kind === "text" ? part.text.length : part.code.length) + 1;
    return { key, part };
  });
  return (
    <>
      {keyed.map(({ key, part }) =>
        part.kind === "text" ? (
          <span key={key} className="whitespace-pre-wrap">
            {part.text}
          </span>
        ) : (
          <div
            key={key}
            className="my-1 rounded-md border border-border bg-raised"
            data-testid="code-block"
          >
            <div className="flex items-center gap-2 border-border border-b px-2 py-1 text-fg-muted text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">
                {part.path ?? part.lang ?? t("session.codeBlock")}
              </span>
              {props.onApply && !part.open ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-6 px-2"
                  aria-label={
                    part.path ? t("session.applyTo", { path: part.path }) : t("session.apply")
                  }
                  onClick={() =>
                    props.onApply?.({ code: part.code, lang: part.lang, path: part.path })
                  }
                >
                  {t("session.apply")}
                </Button>
              ) : null}
            </div>
            <pre className="max-h-64 overflow-auto px-2 py-1 font-mono text-xs">{part.code}</pre>
          </div>
        ),
      )}
    </>
  );
}
