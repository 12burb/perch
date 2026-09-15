/**
 * The Inbox mode (spec §4 "Inbox: sidebar needs-you/mentions/threads/later; main approvals +
 * activity", §5.7 "approval inbox"; task 2.10).
 *
 * One queue of things waiting for one person, across every workspace they are in. The sidebar's
 * four sections are the same queue asked for differently, so the filter lives in the URL: a link to
 * what needs you is a link somebody can send.
 */
import "@perch/ui/i18n/inbox";
import { type MessageKey, t } from "@perch/ui";
import { InboxList, type InboxRow } from "@perch/ui/inbox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  type InboxItemRow,
  type InboxKindFilter,
  type InboxStatusFilter,
  inboxQuery,
} from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";

/** The sidebar's four sections, as what each one asks the api for. */
export const INBOX_FILTERS = ["needs-you", "mentions", "threads", "later"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export function isFilter(value: unknown): value is InboxFilter {
  return typeof value === "string" && (INBOX_FILTERS as readonly string[]).includes(value);
}

export function askFor(filter: InboxFilter): {
  status: InboxStatusFilter;
  kind?: InboxKindFilter;
} {
  switch (filter) {
    case "mentions":
      return { status: "open", kind: "mention" };
    case "threads":
      return { status: "open", kind: "chain" };
    case "later":
      return { status: "snoozed" };
    default:
      return { status: "open" };
  }
}

/** Tomorrow morning, which is what "later" means when nobody says when. */
export function tomorrow(from = new Date()): Date {
  const when = new Date(from);
  when.setDate(when.getDate() + 1);
  when.setHours(9, 0, 0, 0);
  return when.getTime() <= from.getTime() ? new Date(from.getTime() + 60 * 60 * 1000) : when;
}

function rowOf(item: InboxItemRow): InboxRow {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    url: item.url,
    status: item.status,
    snoozedUntil: item.snoozed_until,
    createdAt: item.created_at,
  };
}

/** Refetches the queue whenever something lands in it or leaves it (spec §7.2 `inbox:<user>`). */
export function useLiveInbox(userId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    const socket = getSocket();
    socket.subscribe(`inbox:${userId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic !== `inbox:${userId}`) return;
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    });
  }, [userId, queryClient]);
}

export function InboxMain(props: { filter: InboxFilter; userId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useLiveInbox(props.userId);
  const ask = askFor(props.filter);
  const queue = useQuery(inboxQuery(ask));
  const items = queue.data?.items ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["inbox"] });

  const resolve = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        const result = await api.POST("/api/inbox/{id}/resolve", { params: { path: { id } } });
        if (result.error) throw new RequestFailed(result.response.status, result.error);
      }
    },
    onSuccess: invalidate,
  });

  /** A permission item points at the session and the ask: `<session>:<permission>` (task 2.10). */
  const answer = useMutation({
    mutationFn: async (input: { ids: string[]; decision: "allow" | "deny" }) => {
      for (const id of input.ids) {
        const item = items.find((one) => one.id === id);
        if (!item) continue;
        const cut = item.ref_id.lastIndexOf(":");
        const session = item.ref_id.slice(0, cut);
        const permission = item.ref_id.slice(cut + 1);
        if (!session || !permission) continue;
        unwrap(
          await api.POST("/api/sessions/{s}/permissions/{id}", {
            params: { path: { s: session, id: permission } },
            body: { answer: input.decision },
          }),
        );
      }
    },
    onSuccess: invalidate,
  });

  const snooze = useMutation({
    mutationFn: async (ids: string[]) => {
      const until = tomorrow().toISOString();
      for (const id of ids) {
        unwrap(
          await api.POST("/api/inbox/{id}/snooze", { params: { path: { id } }, body: { until } }),
        );
      }
    },
    onSuccess: invalidate,
  });

  return (
    // The list is the landmark (InboxList labels itself), so this is a plain box around it.
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <h2 className="text-md font-semibold">{t(headingOf(props.filter))}</h2>
        <span className="text-sm text-fg-muted" data-testid="inbox-count">
          {t("inbox.waiting", { count: queue.data?.open ?? 0 })}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto py-2">
        <InboxList
          rows={items.map(rowOf)}
          busy={resolve.isPending || snooze.isPending || answer.isPending}
          onAnswer={(ids, decision) => answer.mutate({ ids, decision })}
          onResolve={(ids) => resolve.mutate(ids)}
          onSnooze={(ids) => snooze.mutate(ids)}
          onOpen={(row) => {
            const item = items.find((one) => one.id === row.id);
            if (item?.url) void navigate({ to: item.url });
          }}
        />
      </div>
    </div>
  );
}

/** The heading each section carries, which is the sidebar section's own name (spec §4). */
function headingOf(filter: InboxFilter): MessageKey {
  switch (filter) {
    case "mentions":
      return "shell.inbox.mentions";
    case "threads":
      return "shell.inbox.threads";
    case "later":
      return "shell.inbox.later";
    default:
      return "shell.inbox.needsYou";
  }
}
