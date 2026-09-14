/**
 * Empty states suggest the next action in one line (spec §4 "States").
 */
import type { ReactNode } from "react";
import { Button } from "../components/primitives.tsx";

export function EmptyState(props: {
  icon?: ReactNode;
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`flex flex-col items-center justify-center gap-2 px-6 py-12 text-center ${props.className ?? ""}`}
    >
      {props.icon ? (
        <div className="text-fg-subtle" aria-hidden="true">
          {props.icon}
        </div>
      ) : null}
      <h2 className="text-md font-semibold">{props.title}</h2>
      <p className="max-w-sm text-sm text-fg-muted">{props.hint}</p>
      {props.actionLabel && props.onAction ? (
        <Button variant="primary" size="md" onClick={props.onAction} className="mt-2">
          {props.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
