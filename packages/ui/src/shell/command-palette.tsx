/**
 * The command palette (spec §4: ⌘K everywhere). Built on cmdk inside a Radix dialog; commands are
 * grouped, filterable, show their bindings, and run on Enter or click.
 */
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { type ReactNode, useEffect } from "react";
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

export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  placeholder?: string;
}) {
  const groups = new Map<string, PaletteCommand[]>();
  for (const command of props.commands) {
    const list = groups.get(command.group) ?? [];
    list.push(command);
    groups.set(command.group, list);
  }
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

/** ⌘K / Ctrl+K opens the palette, except when a focused editor with a selection owns ⌘K (spec §4). */
export function useCommandPaletteShortcut(
  onOpen: () => void,
  options: { isEditorOwning?: () => boolean } = {},
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
      if (options.isEditorOwning?.()) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen, options.isEditorOwning]);
}
