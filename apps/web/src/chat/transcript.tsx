/**
 * What a channel says (spec §5.2; task 2.2): the messages, virtualized; the toolbar that appears on
 * the one under the pointer or the keyboard; the thread that hangs off a message; and the composer
 * that writes the next one, with the mention list §4 promised.
 *
 * A message is blocks, so this renders blocks — text with its mentions picked out, and code. The
 * cards a bot sends (diff, session, tool) and the interactive ones arrive in tasks 2.5 and 2.6.
 */
import "@perch/ui/i18n/chat";
import { Badge, Button, Composer, type MentionQuery, type Suggestion, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  channelMembersQuery,
  channelsQuery,
  type MessageRow,
  membersQuery,
  meQuery,
  messagesQuery,
  threadQuery,
} from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";

function message(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

/** `<@handle>` and `<#name>` split out of a line so they can be drawn as what they are. */
export function splitMentions(
  text: string,
): { kind: "text" | "user" | "channel"; value: string }[] {
  const out: { kind: "text" | "user" | "channel"; value: string }[] = [];
  const pattern = /<([@#])([a-z0-9._-]{1,64})>/gi;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > at) out.push({ kind: "text", value: text.slice(at, index) });
    out.push({ kind: match[1] === "@" ? "user" : "channel", value: match[2] ?? "" });
    at = index + match[0].length;
  }
  if (at < text.length) out.push({ kind: "text", value: text.slice(at) });
  return out;
}

function Blocks(props: { blocks: MessageRow["blocks"] }): ReactNode {
  return (
    <>
      {props.blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "code") {
          return (
            <pre
              key={key}
              className="overflow-x-auto rounded border border-border bg-raised p-2 font-mono text-sm"
            >
              <code>{String(block.code ?? "")}</code>
            </pre>
          );
        }
        const text = String(block.text ?? "");
        return (
          <p key={key} className="whitespace-pre-wrap break-words text-md">
            {splitMentions(text).map((part, i) =>
              part.kind === "text" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line have no id
                <span key={i}>{part.value}</span>
              ) : (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line have no id
                  key={i}
                  data-testid="mention"
                  className="rounded bg-accent-soft px-1 font-medium text-accent"
                >
                  {part.kind === "user" ? "@" : "#"}
                  {part.value}
                </span>
              ),
            )}
          </p>
        );
      })}
    </>
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

type RowActions = {
  onReply: (message: MessageRow) => void;
  onEdit: (message: MessageRow) => void;
  onDelete: (message: MessageRow) => void;
  onPin: (message: MessageRow) => void;
  onBookmark: (message: MessageRow) => void;
  onHistory: (message: MessageRow) => void;
  canDelete: (message: MessageRow) => boolean;
  mine: (message: MessageRow) => boolean;
};

function MessageItem(props: { row: MessageRow; actions: RowActions; inThread: boolean }) {
  const { row, actions } = props;
  if (row.deleted_at) {
    return (
      <article className="px-2 py-1 text-sm text-fg-subtle" data-testid="message">
        {t("chat.deleted")}
      </article>
    );
  }
  return (
    <article
      data-testid="message"
      data-message-id={row.id}
      className="group relative rounded px-2 py-1 hover:bg-surface-2 focus-within:bg-surface-2"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{row.author_name ?? t("chat.someone")}</span>
        <span className="text-sm text-fg-subtle">{when(row.created_at)}</span>
        {row.pinned ? <Badge tone="accent">{t("chat.pinned")}</Badge> : null}
        {row.bookmarked ? <Badge>{t("chat.saved")}</Badge> : null}
      </div>
      <Blocks blocks={row.blocks} />
      {row.edited_at ? (
        <button
          type="button"
          className="text-sm text-fg-subtle underline"
          onClick={() => actions.onHistory(row)}
        >
          {t("chat.edited")}
        </button>
      ) : null}
      {!props.inThread && row.reply_count > 0 ? (
        <button
          type="button"
          data-testid="reply-count"
          className="block text-sm text-accent"
          onClick={() => actions.onReply(row)}
        >
          {t("chat.replies", { count: row.reply_count })}
        </button>
      ) : null}

      {/* The hover toolbar (spec §5.2). It is always in the DOM so the keyboard reaches it. */}
      <div
        role="toolbar"
        aria-label={t("chat.actions", { name: row.author_name ?? "" })}
        className="absolute top-0 right-1 flex items-center gap-1 rounded border border-border bg-surface opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {props.inThread ? null : (
          <Button size="sm" variant="ghost" onClick={() => actions.onReply(row)}>
            {t("chat.reply")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => actions.onPin(row)}>
          {row.pinned ? t("chat.unpin") : t("chat.pin")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => actions.onBookmark(row)}>
          {row.bookmarked ? t("chat.unsave") : t("chat.save")}
        </Button>
        {actions.mine(row) ? (
          <Button size="sm" variant="ghost" onClick={() => actions.onEdit(row)}>
            {t("chat.edit")}
          </Button>
        ) : null}
        {actions.canDelete(row) ? (
          <Button size="sm" variant="ghost" onClick={() => actions.onDelete(row)}>
            {t("chat.delete")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** The channel's own flow, virtualized, following the end while the reader is at the end. */
function Flow(props: { rows: MessageRow[]; actions: RowActions; label: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (index) => props.rows[index]?.id ?? index,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const total = virtualizer.getTotalSize();
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the end as rows arrive and measure
  useEffect(() => {
    if (!nearBottom.current || props.rows.length === 0) return;
    virtualizer.scrollToIndex(props.rows.length - 1, { align: "end" });
    nearBottom.current = true;
  }, [props.rows.length, total]);

  return (
    <div
      ref={parentRef}
      role="log"
      aria-live="polite"
      aria-label={props.label}
      data-testid="channel-flow"
      className="min-h-0 flex-1 overflow-auto px-1 py-2"
    >
      {props.rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-subtle">{t("chat.noMessages")}</p>
      ) : (
        <div className="relative w-full" style={{ height: total }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = props.rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <MessageItem row={row} actions={props.actions} inThread={false} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ChannelTranscript(props: {
  workspaceId: string;
  channelId: string;
  channelName: string;
  canModerate: boolean;
  /** Whether the reader is in the channel: a channel you only watch has no composer. */
  member: boolean;
}) {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const rows = useQuery(messagesQuery(props.workspaceId, props.channelId)).data ?? [];
  const people = useQuery(membersQuery(props.workspaceId)).data ?? [];
  const inChannel = useQuery(channelMembersQuery(props.workspaceId, props.channelId)).data ?? [];
  const channels = useQuery(channelsQuery(props.workspaceId)).data ?? [];
  const [threadRoot, setThreadRoot] = useState<string | null>(null);
  const [editing, setEditing] = useState<MessageRow | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const replies = useQuery(threadQuery(props.workspaceId, threadRoot ?? "")).data ?? [];
  const history = useQuery({
    queryKey: ["workspace", props.workspaceId, "messages", historyOf, "edits"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/messages/{message}/edits", {
          params: { path: { ws: props.workspaceId, message: historyOf ?? "" } },
        }),
      ).edits,
    enabled: Boolean(historyOf),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["workspace", props.workspaceId, "messages", props.channelId],
    });
    if (threadRoot) {
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "thread", threadRoot],
      });
    }
    await queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "channels"] });
  };

  /**
   * Every message.* on this workspace's topic is a reason to look again, and so is a channel.*:
   * somebody who just joined has to be in the mention list before anybody tries to name them.
   */
  useEffect(() => {
    const socket = getSocket();
    socket.subscribe(`ws:${props.workspaceId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic !== `ws:${props.workspaceId}`) return;
      if (envelope.type.startsWith("message.")) void invalidate();
      if (envelope.type.startsWith("channel.")) {
        void queryClient.invalidateQueries({
          queryKey: ["workspace", props.workspaceId, "members"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["workspace", props.workspaceId, "channels", props.channelId, "members"],
        });
      }
    });
  });

  const send = useMutation({
    mutationFn: async (input: { text: string; threadRootId?: string }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/channels/{channel}/messages", {
          params: { path: { ws: props.workspaceId, channel: props.channelId } },
          body: {
            text: input.text,
            ...(input.threadRootId ? { thread_root_id: input.threadRootId } : {}),
          },
        }),
      ),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const patch = useMutation({
    mutationFn: async (input: {
      id: string;
      body: { text?: string; pinned?: boolean; bookmarked?: boolean };
    }) =>
      unwrap(
        await api.PATCH("/api/workspaces/{ws}/messages/{message}", {
          params: { path: { ws: props.workspaceId, message: input.id } },
          body: input.body,
        }),
      ),
    onSuccess: async () => {
      setError(null);
      setEditing(null);
      await invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/messages/{message}", {
        params: { path: { ws: props.workspaceId, message: id } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
      return id;
    },
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const markRead = useMutation({
    mutationFn: async (messageId: string) => {
      const result = await api.POST("/api/workspaces/{ws}/channels/{channel}/read", {
        params: { path: { ws: props.workspaceId, channel: props.channelId } },
        body: { message_id: messageId },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
      return messageId;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "channels"],
      });
    },
  });

  // Reading the channel is what marks it read: the last message you have been shown.
  const lastId = rows.at(-1)?.id ?? "";
  const marked = useRef("");
  useEffect(() => {
    if (!lastId || !props.member || marked.current === lastId) return;
    marked.current = lastId;
    markRead.mutate(lastId);
  }, [lastId, props.member, markRead.mutate]);

  const myId = me.data?.id ?? "";
  const actions: RowActions = {
    onReply: (row) => setThreadRoot(row.thread_root_id ?? row.id),
    onEdit: (row) => setEditing(row),
    onDelete: (row) => remove.mutate(row.id),
    onPin: (row) => patch.mutate({ id: row.id, body: { pinned: !row.pinned } }),
    onBookmark: (row) => patch.mutate({ id: row.id, body: { bookmarked: !row.bookmarked } }),
    onHistory: (row) => setHistoryOf((current) => (current === row.id ? null : row.id)),
    canDelete: (row) => props.canModerate || (row.author_type === "user" && row.author_id === myId),
    mine: (row) => row.author_type === "user" && row.author_id === myId,
  };

  /** Who and what the composer offers: the people in this workspace, and the channels you are in. */
  const suggest = useMemo(
    () =>
      (query: MentionQuery): Suggestion[] => {
        if (query.trigger === "@") {
          const inside = new Set(inChannel.map((row) => row.member_id));
          // A handle comes from an email, so it is often not what somebody is called: the list
          // matches either, which is what a person typing a name expects.
          return people
            .filter(
              (person) =>
                query.text === "" ||
                person.handle.startsWith(query.text) ||
                person.name.toLowerCase().includes(query.text),
            )
            .map((person) => ({
              id: person.user_id,
              label: person.name,
              hint: `@${person.handle}${inside.has(person.user_id) ? "" : ` · ${t("chat.notHere")}`}`,
              insert: `<@${person.handle}>`,
            }));
        }
        return channels
          .filter((row) => row.name && (query.text === "" || row.name.startsWith(query.text)))
          .map((row) => ({
            id: row.id,
            label: `#${row.name ?? ""}`,
            hint: row.topic ?? "",
            insert: `<#${row.name ?? ""}>`,
          }));
      },
    [people, channels, inChannel],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Flow rows={rows} actions={actions} label={t("chat.flowOf", { name: props.channelName })} />

      {historyOf ? (
        <section
          aria-label={t("chat.historyHeading")}
          className="border-t border-border p-2 text-sm"
        >
          <h3 className="font-semibold">{t("chat.historyHeading")}</h3>
          <ul aria-label={t("chat.historyHeading")} className="flex flex-col gap-1 pt-1">
            {(history.data ?? []).map((edit) => (
              <li key={edit.id} className="rounded border border-border p-1" data-testid="edit">
                <Blocks blocks={edit.blocks} />
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" onClick={() => setHistoryOf(null)}>
            {t("chat.historyClose")}
          </Button>
        </section>
      ) : null}

      {editing ? (
        <form
          aria-label={t("chat.editHeading")}
          className="flex items-end gap-2 border-t border-border p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            patch.mutate({ id: editing.id, body: { text: String(data.get("text") ?? "") } });
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-fg-muted">{t("chat.editHeading")}</span>
            <input
              name="text"
              defaultValue={editing.blocks.map((b) => String(b.text ?? "")).join("\n")}
              className="min-h-row rounded border border-border bg-surface px-2 text-md"
            />
          </label>
          <Button type="submit" size="sm" variant="primary">
            {t("chat.editSave")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
            {t("chat.editCancel")}
          </Button>
        </form>
      ) : null}

      {props.member ? (
        <div className="border-t border-border p-2">
          <Composer
            draftKey={`channel-${props.channelId}`}
            label={t("chat.composer", { name: props.channelName })}
            placeholder={t("chat.composerPlaceholder", { name: props.channelName })}
            suggest={suggest}
            onSend={(text) => send.mutate({ text })}
          />
        </div>
      ) : null}

      {threadRoot ? (
        <section
          aria-label={t("chat.threadHeading")}
          data-testid="thread"
          className="flex max-h-[50vh] min-h-0 flex-col border-t border-border"
        >
          <header className="flex items-center gap-2 border-b border-border p-2">
            <h3 className="text-sm font-semibold">{t("chat.threadHeading")}</h3>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setThreadRoot(null)}
            >
              {t("chat.threadClose")}
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {replies.map((row) => (
              <MessageItem key={row.id} row={row} actions={actions} inThread />
            ))}
          </div>
          {props.member ? (
            <div className="border-t border-border p-2">
              <Composer
                draftKey={`thread-${threadRoot}`}
                label={t("chat.threadComposer")}
                placeholder={t("chat.threadComposerPlaceholder")}
                suggest={suggest}
                onSend={(text) => send.mutate({ text, threadRootId: threadRoot })}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="p-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
