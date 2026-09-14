import { type ShellState, ShellToggles } from "@perch/ui";
import type { ReactNode } from "react";

/** Every main region starts with an h1 header row and the region toggles (spec §4 accessibility). */
export function ModePage(props: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  shell: {
    state: ShellState;
    onStateChange: (s: ShellState) => void;
    hasPanel: boolean;
    hasDrawer: boolean;
  };
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-row flex-wrap items-center gap-2 border-b border-border px-3 py-1">
        <h1 className="text-md font-semibold">{props.title}</h1>
        {props.subtitle ? <span className="text-sm text-fg-muted">{props.subtitle}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {props.actions}
          <ShellToggles
            state={props.shell.state}
            onStateChange={props.shell.onStateChange}
            hasPanel={props.shell.hasPanel}
            hasDrawer={props.shell.hasDrawer}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </div>
  );
}
