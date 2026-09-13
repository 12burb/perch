/**
 * The panel (spec §4): the right region for a thread, an agent session, work item properties, a run
 * log. A header with a title, optional actions, and a close button; the body scrolls.
 */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../components/primitives.tsx";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export function Panel(props: {
  title: string;
  onClose?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col", props.className)}>
      <header className="flex min-h-row items-center gap-2 border-b border-border px-3 py-1">
        <h2 className="flex-1 truncate text-md font-semibold">{props.title}</h2>
        {props.actions}
        {props.onClose ? (
          <IconButton label={t("ui.closePanel")} onClick={props.onClose}>
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </div>
  );
}
