/**
 * The rail (spec §4): workspace switcher on top, mode tabs (Home, Code, Work, Bots, Inbox, Search),
 * avatar/settings at the bottom. Pure presentation: the app decides what each tab does.
 */
import {
  Bot,
  ChevronsUpDown,
  Code,
  House,
  Inbox,
  Search,
  Settings,
  SquareKanban,
} from "lucide-react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import { Tooltip } from "../components/overlays.tsx";
import { Avatar, Badge } from "../components/primitives.tsx";
import { type MessageKey, t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export type RailMode = "home" | "code" | "work" | "bots" | "inbox" | "search";

export const RAIL_MODES: ReadonlyArray<{
  mode: RailMode;
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  labelKey: MessageKey;
}> = [
  { mode: "home", icon: House, labelKey: "ui.mode.home" },
  { mode: "code", icon: Code, labelKey: "ui.mode.code" },
  { mode: "work", icon: SquareKanban, labelKey: "ui.mode.work" },
  { mode: "bots", icon: Bot, labelKey: "ui.mode.bots" },
  { mode: "inbox", icon: Inbox, labelKey: "ui.mode.inbox" },
  { mode: "search", icon: Search, labelKey: "ui.mode.search" },
];

/** What a rail tab renders with; apps that route per mode spread these on their Link. */
export type RailTabProps = {
  role: "tab";
  "aria-selected": boolean;
  "aria-label": string;
  tabIndex: number;
  className: string;
  children: ReactNode;
  /**
   * Arrow, Home and End move between the modes (task 4.11). It belongs to every tab rather than to
   * the built-in button, because a tablist with a roving tabindex leaves exactly one tab reachable
   * by Tab: an app that renders its tabs as links and forgets this leaves a keyboard with no way to
   * change mode at all.
   */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

export type RailProps = {
  active: RailMode;
  onSelect: (mode: RailMode) => void;
  /** Unread/needs-you counts per mode. */
  badges?: Partial<Record<RailMode, number>>;
  workspace: { name: string; avatarUrl?: string | null };
  onSwitchWorkspace?: () => void;
  user: { name: string; avatarUrl?: string | null };
  onOpenSettings?: () => void;
  /** Renders each tab as a link when the app routes per mode; spread `tabProps` on the element. */
  renderTab?: (mode: RailMode, tabProps: RailTabProps) => ReactNode;
};

/** The mode an arrow, Home or End moves to from `mode`, or null for any other key. */
export function railStep(key: string, mode: RailMode): RailMode | null {
  const index = RAIL_MODES.findIndex((one) => one.mode === mode);
  const last = RAIL_MODES.length - 1;
  const next =
    key === "Home"
      ? RAIL_MODES[0]
      : key === "End"
        ? RAIL_MODES[last]
        : key === "ArrowDown"
          ? RAIL_MODES[(index + 1) % RAIL_MODES.length]
          : key === "ArrowUp"
            ? RAIL_MODES[(index + last) % RAIL_MODES.length]
            : null;
  return next?.mode ?? null;
}

export function Rail(props: RailProps) {
  // Automatic activation (the ARIA tabs pattern): moving focus selects, because each mode is a
  // route and arriving on it is the point of moving.
  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>, mode: RailMode) => {
    const next = railStep(event.key, mode);
    const to = next ? RAIL_MODES.find((one) => one.mode === next) : undefined;
    if (!to) return;
    event.preventDefault();
    props.onSelect(to.mode);
    const list = event.currentTarget.closest('[role="tablist"]');
    list?.querySelector<HTMLElement>(`[aria-label="${t(to.labelKey)}"]`)?.focus();
  };
  return (
    <div className="flex h-full flex-col items-center gap-1 py-2">
      <Tooltip label={`${props.workspace.name} · ${t("ui.switchWorkspace")}`}>
        <button
          type="button"
          onClick={props.onSwitchWorkspace}
          aria-label={`${props.workspace.name}: ${t("ui.switchWorkspace")}`}
          className="mb-2 flex size-10 items-center justify-center rounded hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Avatar
            name={props.workspace.name}
            src={props.workspace.avatarUrl}
            size="md"
            className="rounded-md"
          />
          <ChevronsUpDown className="-ml-1 size-3 text-fg-subtle" aria-hidden="true" />
        </button>
      </Tooltip>
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t("ui.modes")}
        className="flex flex-col items-center gap-1"
      >
        {RAIL_MODES.map(({ mode, icon: Icon, labelKey }) => {
          const label = t(labelKey);
          const active = props.active === mode;
          const badge = props.badges?.[mode];
          const className = cn(
            "relative flex size-10 items-center justify-center rounded text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-focus",
            active && "bg-accent-soft text-accent",
          );
          const child = (
            <>
              <Icon className="size-5" aria-hidden="true" />
              {badge ? (
                <>
                  <Badge
                    tone="accent"
                    className="absolute -top-1 -right-1 px-1 text-[10px]"
                    aria-hidden="true"
                  >
                    {badge > 99 ? "99+" : badge}
                  </Badge>
                  <span className="sr-only">{t("ui.badgeCount", { count: badge })}</span>
                </>
              ) : null}
            </>
          );
          const tabProps: RailTabProps = {
            role: "tab",
            "aria-selected": active,
            "aria-label": label,
            tabIndex: active ? 0 : -1,
            className,
            children: child,
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => onTabKeyDown(event, mode),
          };
          return (
            <Tooltip key={mode} label={label}>
              {props.renderTab ? (
                props.renderTab(mode, tabProps)
              ) : (
                <button type="button" {...tabProps} onClick={() => props.onSelect(mode)} />
              )}
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-auto flex flex-col items-center gap-1">
        <Tooltip label={t("ui.settings")}>
          <button
            type="button"
            onClick={props.onOpenSettings}
            aria-label={`${props.user.name}: ${t("ui.settings")}`}
            className="flex size-10 items-center justify-center rounded hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Avatar name={props.user.name} src={props.user.avatarUrl} size="md" />
          </button>
        </Tooltip>
        <Settings className="size-3 text-fg-subtle" aria-hidden="true" />
      </div>
    </div>
  );
}
