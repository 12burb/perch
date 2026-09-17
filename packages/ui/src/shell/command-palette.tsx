/**
 * The command palette (spec §4: ⌘K everywhere). Built on cmdk inside a Radix dialog; commands are
 * grouped, filterable, show their bindings, and run on Enter or click.
 */
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { type ReactNode, useEffect, useRef } from "react";
import { Kbd } from "../components/primitives.tsx";
import { t } from "../i18n/index.ts";

export type PaletteCommand = {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
  icon?: ReactNode;
  keywords?: string[];
  run: () => void;
};

/**
 * How many commands a group shows (ADR-0113). A screen contributes its own commands, so the list
 * grows with what is open; cmdk filters as you type, and past fifty rows you are typing anyway.
 */
export const PALETTE_SHOWN = 50;

export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  placeholder?: string;
}) {
  const groups = new Map<string, PaletteCommand[]>();
  for (const command of props.commands) {
    const list = groups.get(command.group) ?? [];
    if (list.length < PALETTE_SHOWN) list.push(command);
    groups.set(command.group, list);
  }
  /**
   * Where focus goes when it closes (task 4.11).
   *
   * A dialog must give focus back to whatever opened it, and land it *somewhere* even when nothing
   * did — a palette opened with ⌘K on a page nobody has tabbed into came from `document.body`, and
   * leaving it there makes the next Tab start the document over. Radix's own restore does not fire
   * for this composition (there is no `Dialog.Trigger`: the palette is opened from a shortcut and
   * from buttons elsewhere), so the last focused element is remembered here instead, by listening
   * while the palette is closed — which is exactly when focus is moving around the page.
   */
  const cameFrom = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (props.open) {
      wasOpen.current = true;
      return;
    }
    const justClosed = wasOpen.current;
    wasOpen.current = false;

    // While it is closed, keep track of where focus is: that is where it goes back to. Anything
    // inside a dialog is not an answer — least of all the palette's own input on the way out,
    // which is where focus still is at the moment a close is committed.
    const remember = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return;
      if (active.closest('[role="dialog"]')) return;
      cameFrom.current = active;
    };
    if (!justClosed) remember();
    document.addEventListener("focusin", remember);

    // …and just after a close, put focus back. Late on purpose: the dialog is still unmounting, and
    // whatever it does with focus on the way out should not be fought, only finished.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (justClosed) {
      timer = setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) return;
        const back = cameFrom.current;
        if (back?.isConnected) {
          back.focus();
          return;
        }
        // Nothing opened it — a shortcut on a page nobody had tabbed into. Focus has to land
        // somewhere all the same, or the next Tab starts the document over.
        const main = document.querySelector("main");
        if (!(main instanceof HTMLElement)) return;
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus();
      }, 100);
    }
    return () => {
      document.removeEventListener("focusin", remember);
      if (timer) clearTimeout(timer);
    };
  }, [props.open]);

  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fixed top-[15vh] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-overlay shadow-lg focus:outline-none"
        >
          <RadixDialog.Title className="sr-only">{t("ui.commandPalette")}</RadixDialog.Title>
          <Command label={t("ui.commandPalette")} loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-fg-subtle" aria-hidden="true" />
              <Command.Input
                autoFocus
                placeholder={props.placeholder ?? t("ui.commandPlaceholder")}
                className="h-11 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-subtle"
              />
              <Kbd keys="Esc" />
            </div>
            <Command.List className="max-h-[50vh] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-muted">
                {t("ui.noResults")}
              </Command.Empty>
              {[...groups.entries()].map(([group, commands]) => (
                <Command.Group
                  key={group}
                  heading={group}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:text-fg-subtle"
                >
                  {commands.map((command) => (
                    <Command.Item
                      key={command.id}
                      value={command.label}
                      keywords={command.keywords}
                      onSelect={() => {
                        props.onOpenChange(false);
                        command.run();
                      }}
                      className="flex h-9 cursor-default items-center gap-2 rounded px-2 text-md text-fg data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent"
                    >
                      {command.icon ? (
                        <span
                          className="flex size-4 items-center justify-center"
                          aria-hidden="true"
                        >
                          {command.icon}
                        </span>
                      ) : null}
                      <span className="flex-1 truncate">{command.label}</span>
                      {command.shortcut ? <Kbd keys={command.shortcut} /> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * ⌘K / Ctrl+K opens the palette, except when an editor claimed that very keydown for an inline
 * edit (spec §4). The editor sees the event first, so it answers for the event, not for a state.
 */
export function useCommandPaletteShortcut(
  onOpen: () => void,
  options: { isEditorOwning?: (event: KeyboardEvent) => boolean } = {},
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (options.isEditorOwning?.(event)) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen, options.isEditorOwning]);
}
