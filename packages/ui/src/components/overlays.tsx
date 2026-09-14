/**
 * Overlays on Radix: Tooltip, Dialog (modal), Sheet (side panel on mobile). Focus is trapped, Esc closes,
 * every surface is labelled, motion follows the tokens (and reduced motion).
 */
import { X } from "lucide-react";
import { Dialog as RadixDialog, Tooltip as RadixTooltip } from "radix-ui";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";
import { IconButton } from "./primitives.tsx";

export function TooltipProvider(props: ComponentProps<typeof RadixTooltip.Provider>) {
  return <RadixTooltip.Provider delayDuration={400} {...props} />;
}

export function Tooltip(props: {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{props.children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={props.side ?? "right"}
          sideOffset={6}
          className="z-50 rounded border border-border bg-overlay px-2 py-1 text-sm text-fg shadow-md"
        >
          {props.label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Extra header actions (e.g. "Open full" in a Peek). */
  actions?: ReactNode;
  className?: string;
  /** center: a modal in the middle; right: a sheet from the right; bottom: a sheet from the bottom. */
  placement?: "center" | "right" | "bottom";
};

/**
 * Controlled dialogs have no Radix Trigger, so remember what was focused when they opened and put focus
 * back there on close (spec §4: keyboard-complete, visible focus).
 */
function useReturnFocus(open: boolean) {
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
  }, [open]);
  return (event: Event) => {
    if (returnTo.current?.isConnected) {
      event.preventDefault();
      returnTo.current.focus();
    }
  };
}

export function Dialog(props: DialogProps) {
  const placement = props.placement ?? "center";
  const onCloseAutoFocus = useReturnFocus(props.open);
  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "fixed z-50 flex flex-col border border-border bg-overlay text-fg shadow-lg focus:outline-none",
            placement === "center" &&
              "top-1/2 left-1/2 max-h-[85vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg",
            placement === "right" && "inset-y-0 right-0 w-[min(480px,100vw)] border-l",
            placement === "bottom" && "inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t",
            props.className,
          )}
        >
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <RadixDialog.Title className="flex-1 truncate text-md font-semibold">
              {props.title}
            </RadixDialog.Title>
            {props.actions}
            <RadixDialog.Close asChild>
              <IconButton label={t("ui.close")}>
                <X className="size-4" aria-hidden="true" />
              </IconButton>
            </RadixDialog.Close>
          </header>
          {props.description ? (
            <RadixDialog.Description className="px-4 pt-3 text-sm text-fg-muted">
              {props.description}
            </RadixDialog.Description>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto p-4">{props.children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A sheet: the sidebar or panel on a phone (spec §4 "Mobile: sidebar as sheet; panel pushes"). */
export function Sheet(
  props: Omit<DialogProps, "placement"> & { side?: "left" | "right" | "bottom" },
) {
  const side = props.side ?? "left";
  const onCloseAutoFocus = useReturnFocus(props.open);
  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "fixed z-50 flex flex-col bg-surface text-fg shadow-lg focus:outline-none",
            side === "left" && "inset-y-0 left-0 w-[min(320px,85vw)] border-r border-border",
            side === "right" && "inset-y-0 right-0 w-[min(360px,90vw)] border-l border-border",
            side === "bottom" &&
              "inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t border-border",
            props.className,
          )}
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <RadixDialog.Title className="flex-1 truncate text-md font-semibold">
              {props.title}
            </RadixDialog.Title>
            {props.actions}
            <RadixDialog.Close asChild>
              <IconButton label={t("ui.close")}>
                <X className="size-4" aria-hidden="true" />
              </IconButton>
            </RadixDialog.Close>
          </header>
          {props.description ? (
            <RadixDialog.Description className="sr-only">
              {props.description}
            </RadixDialog.Description>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
