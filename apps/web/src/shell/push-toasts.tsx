import { Button, t } from "@perch/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { onPush, type PushNote } from "../lib/push.ts";

/**
 * What a push says while the tab is open (task 2.3). The browser draws its own notification when
 * Perch is in the background; when it is not, the worker passes the message to the page and this
 * says it in place, where it can be followed with one tap.
 *
 * It is a live region, so a screen reader hears the mention arrive rather than finding it later.
 */
export function PushToasts() {
  const [notes, setNotes] = useState<PushNote[]>([]);

  useEffect(
    () =>
      onPush((note) => {
        // One per tag, newest first: ten mentions in a channel are one line, not ten.
        setNotes((current) => [note, ...current.filter((old) => old.tag !== note.tag)].slice(0, 3));
      }),
    [],
  );

  if (notes.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("push.arrived")}
      data-testid="push-toasts"
      className="pointer-events-none fixed inset-x-2 bottom-2 z-50 flex flex-col gap-2 sm:left-auto sm:right-4 sm:w-80"
    >
      {notes.map((note) => (
        <div
          key={note.tag}
          data-testid="push-toast"
          className="pointer-events-auto rounded border border-border bg-surface p-2 shadow-md"
        >
          <p className="font-medium text-sm">{note.title}</p>
          <p className="text-sm text-fg-muted">{note.body}</p>
          <div className="mt-1 flex items-center gap-2">
            <Link
              to={note.url}
              className="text-sm text-accent underline"
              onClick={() => setNotes((current) => current.filter((old) => old.tag !== note.tag))}
            >
              {t("push.open")}
            </Link>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setNotes((current) => current.filter((old) => old.tag !== note.tag))}
            >
              {t("common.dismiss")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
