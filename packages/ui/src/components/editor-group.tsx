import { X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { t } from "../i18n/index.ts";
import { EmptyState } from "../shell/empty-state.tsx";
import { cn } from "../utils.ts";
import { IconButton } from "./primitives.tsx";

/**
 * EditorGroup (spec §4 "editor group with tabs and breadcrumbs"): the tab strip, the breadcrumb bar,
 * and the region the active editor renders into. The editor itself (CodeMirror, a preview) is the
 * child; this component owns keyboard navigation between tabs and the dirty marker.
 */

export type EditorTab = {
  id: string;
  title: string;
  /** Unsaved changes: a dot beside the title and an accessible note. */
  dirty?: boolean;
  icon?: ReactNode;
};

export type EditorGroupProps = {
  tabs: EditorTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Segments of the active file's path, root first. */
  breadcrumbs?: string[];
  /** Right side of the breadcrumb bar (save, preview toggle). */
  actions?: ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  children?: ReactNode;
  className?: string;
};

export function EditorGroup(props: EditorGroupProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const active = props.tabs.find((tab) => tab.id === props.activeId) ?? null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = props.tabs.findIndex((tab) => tab.id === props.activeId);
    if (index < 0 || props.tabs.length === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % props.tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + props.tabs.length) % props.tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = props.tabs.length - 1;
    else if (event.key === "Delete" || (event.key === "w" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      props.onClose(props.tabs[index]?.id ?? "");
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const target = props.tabs[next];
    if (!target) return;
    props.onSelect(target.id);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[role="tab"][data-tab-id="${CSS.escape(target.id)}"]`)
      ?.focus();
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", props.className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("editor.tabs")}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex min-h-row shrink-0 items-stretch overflow-x-auto border-b border-border bg-raised"
      >
        {props.tabs.map((tab) => {
          const selected = tab.id === props.activeId;
          return (
            <div
              key={tab.id}
              className={cn(
                "flex items-stretch border-r border-border",
                selected ? "bg-surface" : "text-fg-muted",
              )}
            >
              <button
                type="button"
                role="tab"
                data-tab-id={tab.id}
                aria-selected={selected}
                aria-controls={selected ? "editor-tabpanel" : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => props.onSelect(tab.id)}
                className="flex items-center gap-1.5 px-3 text-sm hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
              >
                {tab.icon ? (
                  <span className="flex size-4 items-center justify-center" aria-hidden="true">
                    {tab.icon}
                  </span>
                ) : null}
                <span className="max-w-48 truncate">{tab.title}</span>
                {tab.dirty ? (
                  <>
                    <span aria-hidden="true" className="text-accent">
                      ●
                    </span>
                    <span className="sr-only">({t("editor.unsaved")})</span>
                  </>
                ) : null}
              </button>
              {/* A pointer affordance only: a tablist may own nothing but tabs, so this stays out
                  of the accessibility tree; keyboards close with Delete / ⌘W on the tab or the
                  labelled Close button in the breadcrumb bar. */}
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                data-close-tab={tab.id}
                onClick={() => props.onClose(tab.id)}
                className="my-auto mr-1 flex size-6 items-center justify-center rounded hover:bg-raised hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      {active ? (
        <div className="flex min-h-row shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
          <nav aria-label={t("editor.breadcrumbs")} className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex items-center gap-1 whitespace-nowrap text-fg-muted">
              {(props.breadcrumbs ?? [active.title]).map((segment, index, all) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: path segments repeat; position is the identity
                  key={`${index}-${segment}`}
                  className="flex items-center gap-1"
                  aria-current={index === all.length - 1 ? "page" : undefined}
                >
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-fg-subtle">
                      /
                    </span>
                  ) : null}
                  <span className={index === all.length - 1 ? "text-fg" : undefined}>
                    {segment}
                  </span>
                </li>
              ))}
            </ol>
          </nav>
          <div className="flex items-center gap-1">
            {props.actions}
            <IconButton
              label={t("editor.closeTab", { title: active.title })}
              variant="ghost"
              size="sm"
              onClick={() => props.onClose(active.id)}
            >
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      ) : null}
      {active ? (
        <div
          id="editor-tabpanel"
          role="tabpanel"
          aria-label={active.title}
          className="min-h-0 flex-1 overflow-auto"
        >
          {props.children}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <EmptyState
            title={props.emptyTitle ?? t("editor.emptyTitle")}
            hint={props.emptyHint ?? t("editor.emptyHint")}
          />
        </div>
      )}
    </div>
  );
}
