/**
 * The drawer under main (spec §4 Code mode): terminal, console, git, problems as tabs. The tab strip is
 * a real tablist; the app supplies the tab contents.
 */
import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { IconButton } from "../components/primitives.tsx";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export type DrawerTab = {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: number;
  content: ReactNode;
};

export function Drawer(props: {
  tabs: DrawerTab[];
  active: string;
  onSelect: (id: string) => void;
  onClose?: () => void;
  actions?: ReactNode;
}) {
  const id = useId();
  const active = props.tabs.find((tab) => tab.id === props.active) ?? props.tabs[0];
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-row items-center gap-1 border-b border-border px-2">
        <div role="tablist" aria-label={t("ui.drawer")} className="flex items-center gap-1">
          {props.tabs.map((tab) => {
            const selected = tab.id === active?.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`${id}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${id}-pane-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => props.onSelect(tab.id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  const index = props.tabs.findIndex((x) => x.id === tab.id);
                  const next =
                    props.tabs[
                      (index + (event.key === "ArrowRight" ? 1 : props.tabs.length - 1)) %
                        props.tabs.length
                    ];
                  if (next) {
                    props.onSelect(next.id);
                    document.getElementById(`${id}-tab-${next.id}`)?.focus();
                  }
                }}
                className={cn(
                  "flex h-7 items-center gap-1 rounded px-2 text-sm text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-focus",
                  selected && "bg-raised text-fg",
                )}
              >
                {tab.icon ? <span aria-hidden="true">{tab.icon}</span> : null}
                {tab.label}
                {tab.badge ? (
                  <span className="rounded bg-danger-soft px-1 text-[10px] text-danger">
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {props.actions}
          {props.onClose ? (
            <IconButton label={t("ui.closeDrawer")} onClick={props.onClose}>
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${id}-pane-${active.id}`}
          aria-labelledby={`${id}-tab-${active.id}`}
          className="min-h-0 flex-1 overflow-auto font-mono text-sm"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
