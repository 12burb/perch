/**
 * The one shell (spec §4): rail | sidebar | main | panel, with a drawer under main. Rail + sidebar + main
 * by default; panel and drawer on demand. Below the `md` breakpoint only main renders, the rail becomes
 * the mobile tab bar, the sidebar a sheet, and the panel pushes over main. Landmarks per region.
 */
import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Sheet } from "../components/overlays.tsx";
import { IconButton } from "../components/primitives.tsx";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export type ShellState = {
  sidebarOpen: boolean;
  panelOpen: boolean;
  drawerOpen: boolean;
  /** On a phone the sidebar and panel are transient sheets, independent of the desktop flags. */
  mobileSheet?: "sidebar" | "panel" | null;
};

export type ShellProps = {
  rail: ReactNode;
  sidebar?: ReactNode;
  sidebarTitle?: string;
  main: ReactNode;
  panel?: ReactNode;
  panelTitle?: string;
  drawer?: ReactNode;
  /** The mobile tab bar rendered below `md`; usually <MobileTabBar/>. */
  mobileTabBar?: ReactNode;
  state: ShellState;
  onStateChange: (state: ShellState) => void;
  className?: string;
};

export const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

export function Shell(props: ShellProps) {
  const mobile = useIsMobile();
  const { state, onStateChange } = props;
  const set = (patch: Partial<ShellState>) => onStateChange({ ...state, ...patch });

  if (mobile) {
    return (
      <div className={cn("flex h-dvh flex-col bg-base text-fg", props.className)}>
        <main id="main" className="relative min-h-0 flex-1 overflow-auto">
          {props.main}
        </main>
        {props.drawer && state.drawerOpen ? (
          <section
            aria-label={t("ui.drawer")}
            className="max-h-[45vh] overflow-auto border-t border-border bg-surface"
          >
            {props.drawer}
          </section>
        ) : null}
        {props.mobileTabBar}
        {props.sidebar ? (
          <Sheet
            open={state.mobileSheet === "sidebar"}
            onOpenChange={(open) => set({ mobileSheet: open ? "sidebar" : null })}
            title={props.sidebarTitle ?? t("ui.sidebar")}
            side="left"
          >
            {props.sidebar}
          </Sheet>
        ) : null}
        {props.panel ? (
          <Sheet
            open={state.mobileSheet === "panel"}
            onOpenChange={(open) => set({ mobileSheet: open ? "panel" : null })}
            title={props.panelTitle ?? t("ui.panel")}
            side="right"
          >
            {props.panel}
          </Sheet>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("flex h-dvh bg-base text-fg", props.className)}>
      <nav
        aria-label={t("ui.rail")}
        className="flex w-rail shrink-0 flex-col border-r border-border bg-surface"
      >
        {props.rail}
      </nav>
      {props.sidebar && state.sidebarOpen ? (
        <aside
          aria-label={props.sidebarTitle ?? t("ui.sidebar")}
          className="flex w-sidebar shrink-0 flex-col overflow-auto border-r border-border bg-surface"
        >
          {props.sidebar}
        </aside>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <main id="main" className="relative flex min-w-0 flex-1 flex-col overflow-auto">
            {props.main}
          </main>
          {props.panel && state.panelOpen ? (
            <aside
              aria-label={props.panelTitle ?? t("ui.panel")}
              className="flex w-panel shrink-0 flex-col overflow-auto border-l border-border bg-surface"
            >
              {props.panel}
            </aside>
          ) : null}
        </div>
        {props.drawer && state.drawerOpen ? (
          <section
            aria-label={t("ui.drawer")}
            className="flex h-drawer shrink-0 flex-col overflow-auto border-t border-border bg-surface"
          >
            {props.drawer}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Toggle buttons for the three on-demand regions (⌘B sidebar, ⌘. panel, ⌘J drawer per spec §4). */
export function ShellToggles(props: {
  state: ShellState;
  onStateChange: (s: ShellState) => void;
  hasPanel?: boolean;
  hasDrawer?: boolean;
}) {
  const mobile = useIsMobile();
  const set = (patch: Partial<ShellState>) => props.onStateChange({ ...props.state, ...patch });
  // On a phone the sidebar and panel are sheets with their own transient state.
  const sidebarOn = mobile ? props.state.mobileSheet === "sidebar" : props.state.sidebarOpen;
  const panelOn = mobile ? props.state.mobileSheet === "panel" : props.state.panelOpen;
  const toggleSidebar = () =>
    mobile
      ? set({ mobileSheet: sidebarOn ? null : "sidebar" })
      : set({ sidebarOpen: !props.state.sidebarOpen });
  const togglePanel = () =>
    mobile
      ? set({ mobileSheet: panelOn ? null : "panel" })
      : set({ panelOpen: !props.state.panelOpen });
  return (
    <div className="flex items-center gap-1">
      <IconButton label={t("ui.toggleSidebar")} aria-pressed={sidebarOn} onClick={toggleSidebar}>
        <PanelLeft className="size-4" aria-hidden="true" />
      </IconButton>
      {props.hasPanel ? (
        <IconButton label={t("ui.togglePanel")} aria-pressed={panelOn} onClick={togglePanel}>
          <PanelRight className="size-4" aria-hidden="true" />
        </IconButton>
      ) : null}
      {props.hasDrawer ? (
        <IconButton
          label={t("ui.toggleDrawer")}
          aria-pressed={props.state.drawerOpen}
          onClick={() => set({ drawerOpen: !props.state.drawerOpen })}
        >
          <PanelBottom className="size-4" aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Shell keyboard bindings (spec §4): ⌘B sidebar, ⌘. panel, ⌘J drawer. */
export function useShellShortcuts(state: ShellState, onStateChange: (s: ShellState) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key === "b") {
        event.preventDefault();
        onStateChange({ ...state, sidebarOpen: !state.sidebarOpen });
      } else if (event.key === ".") {
        event.preventDefault();
        onStateChange({ ...state, panelOpen: !state.panelOpen });
      } else if (event.key === "j") {
        event.preventDefault();
        onStateChange({ ...state, drawerOpen: !state.drawerOpen });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, onStateChange]);
}
