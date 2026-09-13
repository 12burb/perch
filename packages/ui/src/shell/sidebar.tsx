/**
 * The sidebar (spec §4): a header, collapsible sections with unread weight, and items. Slack-style
 * navigation; the app supplies the sections per mode.
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Badge } from "../components/primitives.tsx";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export function Sidebar(props: {
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col", props.className)}>
      {props.header ? (
        <div className="flex min-h-row items-center border-b border-border px-3 py-2">
          {props.header}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto py-2">{props.children}</div>
      {props.footer ? <div className="border-t border-border px-3 py-2">{props.footer}</div> : null}
    </div>
  );
}

export function SidebarSection(props: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  action?: ReactNode;
  unread?: number;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className="px-2 pb-2">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onClick={() => setOpen(!open)}
          className="flex min-h-row flex-1 items-center gap-1 rounded px-1 text-sm font-semibold text-fg-muted uppercase tracking-wide hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          <ChevronRight
            className={cn("size-3 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
          <span id={`${id}-title`}>{props.title}</span>
          {!open && props.unread ? <Badge tone="accent">{props.unread}</Badge> : null}
        </button>
        {props.action}
      </div>
      <ul id={`${id}-list`} hidden={!open} className="flex flex-col gap-px">
        {props.children}
      </ul>
    </section>
  );
}

export function SidebarItem(props: {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  unread?: number;
  muted?: boolean;
  onSelect?: () => void;
  /** Renders as a link when the app routes; otherwise a button. */
  href?: string;
  trailing?: ReactNode;
}) {
  const className = cn(
    "flex min-h-row w-full items-center gap-2 rounded px-2 text-md text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-focus",
    props.active && "bg-accent-soft text-accent",
    props.unread && !props.active && "font-semibold text-fg",
    props.muted && "opacity-60",
  );
  const body = (
    <>
      {props.icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          {props.icon}
        </span>
      ) : null}
      <span className="flex-1 truncate text-left">{props.label}</span>
      {props.unread ? (
        <Badge tone="accent" aria-label={t("ui.unreadCount", { count: props.unread })}>
          {props.unread}
        </Badge>
      ) : null}
      {props.trailing}
    </>
  );
  return (
    <li>
      {props.href ? (
        <a
          href={props.href}
          aria-current={props.active ? "page" : undefined}
          className={className}
          onClick={props.onSelect}
        >
          {body}
        </a>
      ) : (
        <button
          type="button"
          aria-current={props.active ? "page" : undefined}
          className={className}
          onClick={props.onSelect}
        >
          {body}
        </button>
      )}
    </li>
  );
}
