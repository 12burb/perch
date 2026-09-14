/**
 * The mobile bottom tab bar (spec §4 "Mobile"): Home, Work, Inbox, Code, More. 44 px targets.
 */
import { Code, Ellipsis, House, Inbox, SquareKanban } from "lucide-react";
import type { ComponentType } from "react";
import { type MessageKey, t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export type MobileTab = "home" | "work" | "inbox" | "code" | "more";

const TABS: ReadonlyArray<{
  tab: MobileTab;
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  labelKey: MessageKey;
}> = [
  { tab: "home", icon: House, labelKey: "ui.mode.home" },
  { tab: "work", icon: SquareKanban, labelKey: "ui.mode.work" },
  { tab: "inbox", icon: Inbox, labelKey: "ui.mode.inbox" },
  { tab: "code", icon: Code, labelKey: "ui.mode.code" },
  { tab: "more", icon: Ellipsis, labelKey: "ui.more" },
];

export function MobileTabBar(props: {
  active: MobileTab;
  onSelect: (tab: MobileTab) => void;
  badges?: Partial<Record<MobileTab, number>>;
}) {
  return (
    <nav
      aria-label={t("ui.mobileTabs")}
      className="flex shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ tab, icon: Icon, labelKey }) => {
        const active = props.active === tab;
        const badge = props.badges?.[tab];
        return (
          <button
            key={tab}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => props.onSelect(tab)}
            className={cn(
              "relative flex min-h-touch flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-fg-muted focus-visible:outline-2 focus-visible:outline-focus",
              active && "text-accent",
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
            <span>{t(labelKey)}</span>
            {badge ? (
              <>
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-[calc(50%-18px)] rounded bg-accent px-1 text-[10px] text-accent-fg"
                >
                  {badge > 99 ? "99+" : badge}
                </span>
                <span className="sr-only">{t("ui.badgeCount", { count: badge })}</span>
              </>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
