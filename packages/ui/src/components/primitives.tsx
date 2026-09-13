/**
 * The shadcn-style base (spec §4 "Components (packages/ui, shadcn base)"): small, composable, ARIA
 * complete, styled only with the tokens. Overlays live in overlays.tsx.
 */

import { cva, type VariantProps } from "class-variance-authority";
import { Bot } from "lucide-react";
import { Avatar as RadixAvatar, Label as RadixLabel, Separator as RadixSeparator } from "radix-ui";
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { t } from "../i18n/index.ts";
import { cn } from "../utils.ts";

export const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:opacity-90",
        secondary: "border border-border bg-surface text-fg hover:bg-raised",
        ghost: "text-fg hover:bg-raised",
        danger: "border border-danger text-danger hover:bg-danger-soft",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2 text-sm",
        md: "h-8 px-3 text-md",
        lg: "h-10 px-4 text-md",
        icon: "size-8",
        touch: "min-h-touch min-w-touch px-3",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

/** An icon-only button must carry a label (spec §4 accessibility). */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(
  function IconButton({ label, children, variant = "ghost", size = "icon", ...props }, ref) {
    return (
      <Button ref={ref} variant={variant} size={size} aria-label={label} title={label} {...props}>
        {children}
      </Button>
    );
  },
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-8 w-full rounded border border-border bg-surface px-3 text-md text-fg placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-16 w-full resize-none rounded border border-border bg-surface px-3 py-2 text-md text-fg placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export function Label({ className, ...props }: ComponentProps<typeof RadixLabel.Root>) {
  return <RadixLabel.Root className={cn("text-sm font-medium text-fg", className)} {...props} />;
}

/** Label + control + optional hint/error, wired with ids for screen readers. */
export function Field(props: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: (control: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => ReactNode;
}) {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  const errorId = props.error ? `${props.id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children({
        id: props.id,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(props.error ? { "aria-invalid": true } : {}),
      })}
      {props.hint ? (
        <p id={hintId} className="text-sm text-fg-muted">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function Separator({ className, ...props }: ComponentProps<typeof RadixSeparator.Root>) {
  return (
    <RadixSeparator.Root
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "bg-raised text-fg-muted",
        accent: "bg-accent-soft text-accent",
        bot: "bg-bot-soft text-bot",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        success: "bg-success-soft text-success",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** The BOT badge (spec §4 "Bots in the UI"). */
export function BotBadge({ className }: { className?: string }) {
  return (
    <Badge tone="bot" className={className} aria-label={t("ui.bot")}>
      <Bot className="size-3" aria-hidden="true" />
      {t("ui.bot")}
    </Badge>
  );
}

export function Avatar(props: {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const size = props.size ?? "md";
  const initials = props.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <RadixAvatar.Root
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-raised text-fg-muted",
        size === "sm" && "size-6 text-sm",
        size === "md" && "size-8 text-sm",
        size === "lg" && "size-10 text-md",
        props.className,
      )}
    >
      {props.src ? (
        <RadixAvatar.Image src={props.src} alt={props.name} className="size-full object-cover" />
      ) : null}
      <RadixAvatar.Fallback delayMs={props.src ? 300 : 0} aria-label={props.name}>
        {initials}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
}

/** A keyboard shortcut, rendered per platform (⌘ on Mac, Ctrl elsewhere). */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const label = mac
    ? keys
    : keys.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+").replace(/⌥/g, "Alt+");
  return (
    <kbd
      className={cn(
        "inline-flex h-5 items-center rounded border border-border bg-raised px-1 font-mono text-sm text-fg-muted",
        className,
      )}
    >
      {label}
    </kbd>
  );
}

/** A visually hidden but announced label (e.g. for live regions). */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
