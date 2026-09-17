/**
 * The app shell (spec §4): the @perch/ui Shell wired to routing, the current workspace, the per-mode
 * sidebars, the command palette, the account menu, and the mobile "More" sheet. Shell state (sidebar,
 * panel, drawer) is remembered per mode in localStorage.
 */
import {
  Avatar,
  Badge,
  Button,
  CommandPalette,
  Dialog,
  type MobileTab,
  MobileTabBar,
  type PaletteCommand,
  Rail,
  type RailMode,
  Sheet,
  Shell,
  type ShellState,
  TooltipProvider,
  t,
  useCommandPaletteShortcut,
  useIsMobile,
  useShellShortcuts,
} from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { LogOut, Settings, ShieldCheck, UserRound } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { editorOwnsCommandKey } from "../code/editor-focus.ts";
import { authClient } from "../lib/auth-client.ts";
import { type Me, type MyWorkspace, workspacesQuery } from "../lib/queries.ts";
import { forgetWorkspace, rememberWorkspace } from "../lib/workspace.ts";
import { resetSocket } from "../lib/ws.ts";
import { ModeSidebar, SettingsSidebar } from "./sidebars.tsx";

export type ShellContextValue = {
  me: Me;
  workspace: MyWorkspace | null;
  workspaces: MyWorkspace[];
  mode: RailMode | "settings" | "welcome";
  shell: {
    state: ShellState;
    onStateChange: (s: ShellState) => void;
    hasPanel: boolean;
    hasDrawer: boolean;
  };
  setPanel: (panel: { title: string; content: ReactNode } | null) => void;
  setDrawer: (drawer: ReactNode | null) => void;
  /**
   * Commands this screen contributes to ⌘K (task 2.18): a project's quick actions belong to the
   * project, not the shell, and they leave when the screen does.
   */
  setCommands: (commands: PaletteCommand[]) => void;
  openPalette: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);

export function useAppShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useAppShell outside AppShell");
  return value;
}

const DEFAULT_STATE: ShellState = { sidebarOpen: true, panelOpen: false, drawerOpen: false };

function readState(mode: string): ShellState {
  try {
    const raw = localStorage.getItem(`perch.shell.${mode}`);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ShellState>;
    return { ...DEFAULT_STATE, ...parsed, mobileSheet: null };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeState(mode: string, state: ShellState): void {
  try {
    const { mobileSheet: _transient, ...persisted } = state;
    localStorage.setItem(`perch.shell.${mode}`, JSON.stringify(persisted));
  } catch {
    // storage unavailable: state lasts for the tab
  }
}

export function modeFromPath(
  pathname: string,
  workspaceSlug: string | null,
): RailMode | "settings" | "welcome" {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/welcome") return "welcome";
  const parts = pathname.split("/").filter(Boolean);
  if (workspaceSlug && parts[0] === workspaceSlug) {
    const second = parts[1];
    if (second === "settings" || second === "environments") return "settings";
    if (second && ["home", "code", "work", "bots", "inbox", "search"].includes(second))
      return second as RailMode;
  }
  return "home";
}

export function AppShell(props: { me: Me; workspace: MyWorkspace | null; children: ReactNode }) {
  const { me, workspace } = props;
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const workspaces = useQuery(workspacesQuery).data ?? [];
  const mode = modeFromPath(location.pathname, workspace?.slug ?? null);
  const stateKey = mode === "welcome" ? "settings" : mode;
  const [state, setState] = useState<ShellState>(() => readState(stateKey));
  const [panel, setPanel] = useState<{ title: string; content: ReactNode } | null>(null);
  const [drawer, setDrawer] = useState<ReactNode | null>(null);
  const [extraCommands, setCommands] = useState<PaletteCommand[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    setState(readState(stateKey));
    setPanel(null);
    setDrawer(null);
    setCommands([]);
  }, [stateKey]);

  useEffect(() => {
    if (workspace) rememberWorkspace(workspace.slug);
  }, [workspace]);

  const onStateChange = useCallback(
    (next: ShellState) => {
      setState(next);
      writeState(stateKey, next);
    },
    [stateKey],
  );
  useShellShortcuts(state, onStateChange);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  // ⌘K is the palette everywhere except a focused editor with a selection, where it is the inline
  // edit (spec §4 keyboard; task 1.14).
  useCommandPaletteShortcut(openPalette, { isEditorOwning: editorOwnsCommandKey });

  const goMode = useCallback(
    (target: RailMode) => {
      if (!workspace) {
        void navigate({ to: "/welcome" });
        return;
      }
      void navigate({
        to: "/$workspace/$mode",
        params: { workspace: workspace.slug, mode: target },
      });
    },
    [navigate, workspace],
  );

  const signOut = useCallback(async () => {
    setAccountOpen(false);
    setMoreOpen(false);
    await navigate({ to: "/sign-in" });
    resetSocket();
    forgetWorkspace();
    await authClient.signOut();
  }, [navigate]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const modes: RailMode[] = ["home", "code", "work", "bots", "inbox", "search"];
    const nav: PaletteCommand[] = modes.map((m) => ({
      id: `go-${m}`,
      label: t("palette.goTo", { mode: t(`ui.mode.${m}`) }),
      group: t("palette.navigate"),
      run: () => goMode(m),
    }));
    return [
      ...extraCommands,
      ...nav,
      {
        id: "toggle-sidebar",
        label: t("ui.toggleSidebar"),
        group: t("palette.view"),
        shortcut: "⌘B",
        run: () => onStateChange({ ...state, sidebarOpen: !state.sidebarOpen }),
      },
      {
        id: "toggle-panel",
        label: t("ui.togglePanel"),
        group: t("palette.view"),
        shortcut: "⌘.",
        run: () => onStateChange({ ...state, panelOpen: !state.panelOpen }),
      },
      {
        id: "toggle-drawer",
        label: t("ui.toggleDrawer"),
        group: t("palette.view"),
        shortcut: "⌘J",
        run: () => onStateChange({ ...state, drawerOpen: !state.drawerOpen }),
      },
      {
        id: "switch-workspace",
        label: t("ui.switchWorkspace"),
        group: t("palette.workspace"),
        run: () => setSwitcherOpen(true),
      },
      {
        id: "settings-profile",
        label: t("settings.profile"),
        group: t("palette.account"),
        run: () => void navigate({ to: "/settings/profile" }),
      },
      {
        id: "settings-security",
        label: t("settings.security"),
        group: t("palette.account"),
        run: () => void navigate({ to: "/settings/security" }),
      },
      ...(workspace
        ? [
            {
              id: "environments",
              label: t("environments.title"),
              group: t("palette.workspace"),
              run: () =>
                void navigate({
                  to: "/$workspace/environments",
                  params: { workspace: workspace.slug },
                }),
            },
            {
              id: "hub",
              label: t("hub.title"),
              group: t("palette.workspace"),
              run: () =>
                void navigate({ to: "/$workspace/hub", params: { workspace: workspace.slug } }),
            },
          ]
        : []),
      {
        id: "sign-out",
        label: t("nav.signOut"),
        group: t("palette.account"),
        run: () => void signOut(),
      },
    ];
  }, [extraCommands, goMode, navigate, onStateChange, signOut, state, workspace]);

  const railMode: RailMode = mode === "settings" || mode === "welcome" ? "home" : mode;
  const mobileTab: MobileTab =
    mode === "settings" || mode === "welcome" || mode === "bots" || mode === "search"
      ? "more"
      : mode;

  const sidebar =
    mode === "settings" || mode === "welcome" ? (
      <SettingsSidebar
        workspace={workspace}
        renderItem={(item) => (
          <li key={item.key}>
            <Link
              to={item.to}
              activeProps={{ "aria-current": "page", className: "bg-accent-soft text-accent" }}
              className="flex min-h-row w-full items-center rounded px-2 text-md text-fg-muted hover:bg-raised hover:text-fg"
              onClick={() => onStateChange({ ...state, mobileSheet: null })}
            >
              {item.label}
            </Link>
          </li>
        )}
      />
    ) : (
      <ModeSidebar mode={railMode} workspace={workspace} />
    );

  const value: ShellContextValue = {
    me,
    workspace,
    workspaces,
    mode,
    shell: { state, onStateChange, hasPanel: panel !== null, hasDrawer: drawer !== null },
    setPanel,
    setDrawer,
    setCommands,
    openPalette,
  };

  const accountMenu = (
    <Dialog open={accountOpen} onOpenChange={setAccountOpen} title={me.name} description={me.email}>
      <nav aria-label={t("shell.account")} className="flex flex-col gap-1">
        <Link
          to="/settings/profile"
          onClick={() => setAccountOpen(false)}
          className="flex min-h-touch items-center gap-2 rounded px-2 hover:bg-raised"
        >
          <UserRound className="size-4" aria-hidden="true" /> {t("settings.profile")}
        </Link>
        <Link
          to="/settings/security"
          onClick={() => setAccountOpen(false)}
          className="flex min-h-touch items-center gap-2 rounded px-2 hover:bg-raised"
        >
          <ShieldCheck className="size-4" aria-hidden="true" /> {t("settings.security")}
        </Link>
        {workspace ? (
          <Link
            to="/$workspace/settings"
            params={{ workspace: workspace.slug }}
            onClick={() => setAccountOpen(false)}
            className="flex min-h-touch items-center gap-2 rounded px-2 hover:bg-raised"
          >
            <Settings className="size-4" aria-hidden="true" /> {t("settings.workspace")}
          </Link>
        ) : null}
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex min-h-touch items-center gap-2 rounded px-2 text-left hover:bg-raised"
        >
          <LogOut className="size-4" aria-hidden="true" /> {t("nav.signOut")}
        </button>
      </nav>
    </Dialog>
  );

  const switcher = (
    <Dialog open={switcherOpen} onOpenChange={setSwitcherOpen} title={t("ui.switchWorkspace")}>
      <ul aria-label={t("shell.yourWorkspaces")} className="flex flex-col gap-1">
        {workspaces.map((ws) => (
          <li key={ws.id} data-workspace-id={ws.id}>
            <Link
              to="/$workspace/$mode"
              params={{ workspace: ws.slug, mode: "home" }}
              onClick={() => setSwitcherOpen(false)}
              aria-current={ws.id === workspace?.id ? "true" : undefined}
              className="flex min-h-touch items-center gap-3 rounded px-2 hover:bg-raised aria-[current=true]:bg-accent-soft"
            >
              <Avatar name={ws.name} size="sm" className="rounded" />
              <span className="flex-1 truncate">{ws.name}</span>
              <Badge>{t(`home.role.${ws.role}`)}</Badge>
            </Link>
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        className="mt-3"
        onClick={() => {
          setSwitcherOpen(false);
          void navigate({ to: "/welcome" });
        }}
      >
        {t("home.createWorkspace")}
      </Button>
    </Dialog>
  );

  const more = (
    <Sheet open={moreOpen} onOpenChange={setMoreOpen} title={t("ui.more")} side="bottom">
      <nav aria-label={t("ui.more")} className="flex flex-col gap-1 p-2">
        <p className="px-2 py-1 text-sm text-fg-muted">{t("auth.signedInAs", { name: me.name })}</p>
        {(["bots", "search"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMoreOpen(false);
              goMode(m);
            }}
            className="flex min-h-touch items-center rounded px-2 text-left hover:bg-raised"
          >
            {t(`ui.mode.${m}`)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setMoreOpen(false);
            setSwitcherOpen(true);
          }}
          className="flex min-h-touch items-center rounded px-2 text-left hover:bg-raised"
        >
          {t("ui.switchWorkspace")}
        </button>
        <Link
          to="/settings/profile"
          onClick={() => setMoreOpen(false)}
          className="flex min-h-touch items-center rounded px-2 hover:bg-raised"
        >
          {t("settings.profile")}
        </Link>
        <Link
          to="/settings/security"
          onClick={() => setMoreOpen(false)}
          className="flex min-h-touch items-center rounded px-2 hover:bg-raised"
        >
          {t("settings.security")}
        </Link>
        {workspace ? (
          <Link
            to="/$workspace/settings"
            params={{ workspace: workspace.slug }}
            onClick={() => setMoreOpen(false)}
            className="flex min-h-touch items-center rounded px-2 hover:bg-raised"
          >
            {t("settings.workspace")}
          </Link>
        ) : null}
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex min-h-touch items-center rounded px-2 text-left hover:bg-raised"
        >
          {t("nav.signOut")}
        </button>
      </nav>
    </Sheet>
  );

  return (
    <ShellContext.Provider value={value}>
      <TooltipProvider>
        <Shell
          state={state}
          onStateChange={onStateChange}
          rail={
            <Rail
              active={railMode}
              onSelect={goMode}
              workspace={{ name: workspace?.name ?? t("shell.noWorkspace") }}
              onSwitchWorkspace={() => setSwitcherOpen(true)}
              user={{ name: me.name }}
              onOpenSettings={() => setAccountOpen(true)}
              renderTab={(target, tabProps) =>
                workspace ? (
                  <Link
                    key={target}
                    to="/$workspace/$mode"
                    params={{ workspace: workspace.slug, mode: target }}
                    {...tabProps}
                  />
                ) : (
                  <Link key={target} to="/welcome" {...tabProps} />
                )
              }
            />
          }
          sidebarTitle={mode === "settings" ? t("settings.title") : t(`ui.mode.${railMode}`)}
          sidebar={sidebar}
          main={
            <>
              <span className="sr-only" data-testid="signed-in-as">
                {t("auth.signedInAs", { name: me.name })}
              </span>
              {props.children}
            </>
          }
          panelTitle={panel?.title}
          panel={panel?.content}
          drawer={drawer}
          mobileTabBar={
            <MobileTabBar
              active={mobileTab}
              onSelect={(tab) => {
                if (tab === "more") setMoreOpen(true);
                else goMode(tab);
              }}
            />
          }
        />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
        {accountMenu}
        {switcher}
        {mobile ? more : null}
      </TooltipProvider>
    </ShellContext.Provider>
  );
}
