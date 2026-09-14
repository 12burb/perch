/**
 * Self-contained demos the component tests mount (Playwright CT mounts importable components only).
 * Not exported from the package index.
 */
import { Bug, GitBranch, Hash, ScrollText, Terminal } from "lucide-react";
import { useCallback, useState } from "react";
import { TooltipProvider } from "../components/overlays.tsx";
import {
  Avatar,
  Badge,
  BotBadge,
  Button,
  Field,
  IconButton,
  Input,
  Kbd,
  Separator,
  Textarea,
} from "../components/primitives.tsx";
import {
  CommandPalette,
  type PaletteCommand,
  useCommandPaletteShortcut,
} from "./command-palette.tsx";
import { Composer } from "./composer.tsx";
import { Drawer } from "./drawer.tsx";
import { EmptyState } from "./empty-state.tsx";
import { MobileTabBar } from "./mobile-tab-bar.tsx";
import { Panel } from "./panel.tsx";
import { Peek } from "./peek.tsx";
import { Rail, type RailMode } from "./rail.tsx";
import { Shell, type ShellState, ShellToggles, useShellShortcuts } from "./shell.tsx";
import { Sidebar, SidebarItem, SidebarSection } from "./sidebar.tsx";

export function ShellDemo(props: { initial?: Partial<ShellState> }) {
  const [state, setState] = useState<ShellState>({
    sidebarOpen: true,
    panelOpen: true,
    drawerOpen: true,
    ...props.initial,
  });
  const [mode, setMode] = useState<RailMode>("home");
  const [tab, setTab] = useState("terminal");
  const [mobileTab, setMobileTab] = useState<"home" | "work" | "inbox" | "code" | "more">("home");
  const onStateChange = useCallback((next: ShellState) => setState(next), []);
  useShellShortcuts(state, onStateChange);
  return (
    <TooltipProvider>
      <Shell
        state={state}
        onStateChange={onStateChange}
        rail={
          <Rail
            active={mode}
            onSelect={setMode}
            badges={{ inbox: 3 }}
            workspace={{ name: "The Nest" }}
            user={{ name: "Dawn Bird" }}
          />
        }
        sidebarTitle="Channels"
        sidebar={
          <Sidebar header={<strong>The Nest</strong>}>
            <SidebarSection title="Channels" unread={2}>
              <SidebarItem label="general" icon={<Hash className="size-4" />} active unread={2} />
              <SidebarItem label="newsroom" icon={<Hash className="size-4" />} />
            </SidebarSection>
            <SidebarSection title="Direct messages" defaultOpen={false}>
              <SidebarItem label="Julius" />
            </SidebarSection>
          </Sidebar>
        }
        main={
          <div className="p-4" data-testid="main-content">
            <ShellToggles state={state} onStateChange={onStateChange} hasPanel hasDrawer />
            <p>Mode: {mode}</p>
            <button type="button" onClick={() => setState({ ...state, sidebarOpen: true })}>
              Open sidebar
            </button>
          </div>
        }
        panelTitle="Thread"
        panel={
          <Panel title="Thread" onClose={() => setState({ ...state, panelOpen: false })}>
            <p className="p-3">Panel body</p>
          </Panel>
        }
        drawer={
          <Drawer
            active={tab}
            onSelect={setTab}
            onClose={() => setState({ ...state, drawerOpen: false })}
            tabs={[
              {
                id: "terminal",
                label: "Terminal",
                icon: <Terminal className="size-3.5" />,
                content: <pre className="p-2">$ bun run dev</pre>,
              },
              {
                id: "console",
                label: "Console",
                icon: <ScrollText className="size-3.5" />,
                content: <p className="p-2">console</p>,
              },
              {
                id: "git",
                label: "Git",
                icon: <GitBranch className="size-3.5" />,
                content: <p className="p-2">git</p>,
              },
              {
                id: "problems",
                label: "Problems",
                icon: <Bug className="size-3.5" />,
                badge: 2,
                content: <p className="p-2">problems</p>,
              },
            ]}
          />
        }
        mobileTabBar={
          <MobileTabBar active={mobileTab} onSelect={setMobileTab} badges={{ inbox: 3 }} />
        }
      />
    </TooltipProvider>
  );
}

export function PaletteDemo() {
  const [open, setOpen] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  const onOpen = useCallback(() => setOpen(true), []);
  useCommandPaletteShortcut(onOpen);
  const commands: PaletteCommand[] = [
    {
      id: "new-session",
      label: "New session",
      group: "Code",
      shortcut: "⌘L",
      run: () => setRan("new-session"),
    },
    {
      id: "toggle-sidebar",
      label: "Toggle sidebar",
      group: "View",
      shortcut: "⌘B",
      run: () => setRan("toggle-sidebar"),
    },
    {
      id: "go-inbox",
      label: "Go to Inbox",
      group: "Navigate",
      keywords: ["approvals"],
      run: () => setRan("go-inbox"),
    },
  ];
  return (
    <div className="p-4">
      <Button onClick={onOpen}>Open palette</Button>
      <p data-testid="ran">{ran ?? "nothing"}</p>
      <CommandPalette open={open} onOpenChange={setOpen} commands={commands} />
    </div>
  );
}

export function ComposerDemo(props: { draftKey?: string; running?: boolean }) {
  const [sent, setSent] = useState<string[]>([]);
  const [cancelled, setCancelled] = useState(0);
  const [running, setRunning] = useState(props.running ?? false);
  return (
    <div className="p-4">
      <ul aria-label="Sent">
        {sent.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <p data-testid="cancelled">{cancelled}</p>
      <Composer
        draftKey={props.draftKey ?? "demo"}
        onSend={(text) => setSent((prev) => [...prev, text])}
        running={running}
        onCancel={() => {
          setCancelled((n) => n + 1);
          setRunning(false);
        }}
        onAttach={() => undefined}
      />
    </div>
  );
}

export function PeekDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="p-4">
      <Button onClick={() => setOpen(true)}>Peek NEST-123</Button>
      <Peek
        open={open}
        onOpenChange={setOpen}
        title="Fix login redirect"
        identifier="NEST-123"
        fullHref="/work/NEST-123"
      >
        <p>Work item body</p>
      </Peek>
    </div>
  );
}

export function PrimitivesDemo() {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="link">Link</Button>
          <IconButton label="Settings">
            <Bug className="size-4" />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="warning">Needs you</Badge>
          <Badge tone="danger">Error</Badge>
          <Badge tone="success">Done</Badge>
          <BotBadge />
          <Kbd keys="⌘K" />
          <Avatar name="Dawn Bird" />
        </div>
        <Separator />
        <Field id="name" label="Name" hint="Shown to your team">
          {(control) => <Input {...control} defaultValue="Dawn" />}
        </Field>
        <Field id="bio" label="Bio" error="Too long">
          {(control) => <Textarea {...control} defaultValue="…" />}
        </Field>
        <EmptyState
          title="No channels yet"
          hint="Create the first channel to start talking."
          actionLabel="Create channel"
          onAction={() => undefined}
        />
      </div>
    </TooltipProvider>
  );
}
