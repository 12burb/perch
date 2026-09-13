import { cn } from "@perch/ui";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Minimal form primitives until packages/ui ships the shadcn base (task 0.11). */

export function Field(props: {
  id: string;
  label: string;
  hint?: string;
  children?: ReactNode;
  inputProps: InputHTMLAttributes<HTMLInputElement>;
}) {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-sm font-medium">
        {props.label}
      </label>
      <input
        id={props.id}
        aria-describedby={hintId}
        className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-base text-fg"
        {...props.inputProps}
      />
      {props.hint ? (
        <p id={hintId} className="text-xs text-fg-muted">
          {props.hint}
        </p>
      ) : null}
      {props.children}
    </div>
  );
}

export function Button({
  variant = "primary",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button
      type={rest.type ?? "button"}
      className={cn(
        "inline-flex min-h-10 items-center justify-center rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60",
        variant === "primary" && "bg-accent text-accent-fg",
        variant === "secondary" && "border border-border bg-bg-elevated text-fg",
        variant === "danger" && "border border-danger text-danger",
        className,
      )}
      {...rest}
    />
  );
}

export function ErrorText({ children, id }: { children: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-sm text-danger">
      {children}
    </p>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`${title}-heading`}
      className="w-full max-w-md rounded-lg border border-border bg-bg-elevated p-6 shadow-sm"
    >
      <h1 id={`${title}-heading`} className="mb-4 text-xl font-semibold">
        {title}
      </h1>
      {children}
    </section>
  );
}
