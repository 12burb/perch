/**
 * What a channel says (spec §5.2; task 2.2): the messages, virtualized; the toolbar that appears on
 * the one under the pointer or the keyboard; the thread that hangs off a message; and the composer
 * that writes the next one, with the mention list §4 promised.
 *
 * A message is blocks, so this renders blocks — text with its mentions picked out, code, and the
 * files it points at. The interactive ones are the shared BlockRenderer's (task 2.5); the cards a
 * session sends (diff, session, tool) arrive with the bot runtime in 2.6.
 */
import "@perch/ui/i18n/chat";
import {
  Badge,
  BotBadge,
  Button,
  Composer,
  type MentionQuery,
  type Suggestion,
  t,
} from "@perch/ui";
import { type BlockAct, BlockRenderer, type ChatBlock } from "@perch/ui/blocks";
import { ChainHeader, type ChainHop } from "@perch/ui/chain";
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

/**
 * Perch identifiers in a line — `session:8f2c`, `project:NEST`, `channel:general`, `message:<id>`
 * and their `perch://` longhand. Kept in step with `identifiersIn` in the api's unfurl service,
 * which is the side that decides what any of them resolve to.
 */
export function identifiersIn(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|[\s(<])(session|project|channel|message):([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g,
    /perch:\/\/(session|project|channel|message)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const identifier = `${(match[1] ?? "").toLowerCase()}:${match[2] ?? ""}`;
      if (!found.includes(identifier)) found.push(identifier);
    }
  }
  return found;
}

export type UnfurlCard = {
  identifier: string;
  kind: string;
  title: string;
  subtitle: string | null;
  url: string;
};

/** What an identifier turned out to be, as a card under the message that said it. */
function Unfurls(props: { row: MessageRow; cards: Map<string, UnfurlCard> }) {
  const found = props.row.blocks
    .flatMap((block) => identifiersIn(String(block.text ?? "")))
    .map((identifier) => props.cards.get(identifier))
    .filter((card): card is UnfurlCard => Boolean(card));
  if (found.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {found.map((card) => (
        <a
          key={card.identifier}
          href={card.url}
          data-testid="unfurl"
          className="block rounded border border-border border-l-2 border-l-accent bg-raised px-2 py-1 text-sm hover:bg-surface-2"
        >
          <span className="font-medium">{card.title}</span>
          {card.subtitle ? <span className="text-fg-subtle"> · {card.subtitle}</span> : null}
        </a>
      ))}
    </div>
  );
}

/** Bytes, the way a chat says them. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An image is shown; anything else is named, and both are a link to the download. */
function FileBlock(props: { file: MessageRow["files"][number] }) {
  const { file } = props;
  return (
    <a
      href={`/api/files/${file.id}`}
      data-testid="file"
      download={file.name}
      className="mt-1 inline-flex max-w-full flex-col gap-1 rounded border border-border bg-raised p-2 text-sm hover:bg-surface-2"
    >
      {file.preview ? (
        <img
          src={`/api/files/${file.id}/preview`}
          alt={file.name}
          className="max-h-64 max-w-full rounded object-contain"
        />
      ) : null}
      <span className="truncate">
        {file.name} · {sizeOf(file.size)}
      </span>
    </a>
  );
}

/** The blocks the shared renderer owns; everything else this file draws itself. */
const INTERACTIVE = new Set(["button", "select", "form", "approve_deny"]);

function Blocks(props: {
  blocks: MessageRow["blocks"];
  files?: MessageRow["files"];
  /** Left out for a reader: the blocks still show, they just take no answer (task 2.5). */
  onAct?: ((input: BlockAct) => void) | undefined;
  acting?: string | null;
}): ReactNode {
  return (
    <>
      {props.blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        const blockId = typeof block.id === "string" ? block.id : "";
        if (INTERACTIVE.has(block.type) || block.type === "progress") {
          return (
            <BlockRenderer
              key={key}
              block={block as ChatBlock}
              {...(props.onAct ? { onAct: props.onAct } : {})}
              pending={props.acting !== null && props.acting === blockId}
            />
          );
        }
        if (block.type === "file") {
          const file = (props.files ?? []).find((row) => row.id === block.fileId);
          return file ? <FileBlock key={key} file={file} /> : null;
        }
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

/** The emoji the picker offers first. Everything else arrives with the full picker in Phase 3. */
const QUICK = ["\u{1F44D}", "\u{1F389}", "\u{1F440}", "\u2764\uFE0F", "\u{1F604}", "\u{1F680}"];

/** The pills under a message: one per emoji, each a toggle of your own reaction (task 2.3). */
function Reactions(props: { row: MessageRow; onReact: RowActions["onReact"] }) {
  if (props.row.reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {props.row.reactions.map((pill) => (
        <button
          key={pill.emoji}
          type="button"
          data-testid="reaction"
          aria-pressed={pill.mine}
          aria-label={t("chat.reactionCount", { emoji: pill.emoji, count: pill.count })}
          onClick={() => props.onReact(props.row, pill.emoji, !pill.mine)}
          className={`rounded-full border px-2 text-sm ${
            pill.mine ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface-2"
          }`}
        >
          <span aria-hidden="true">
            {pill.emoji} {pill.count}
          </span>
        </button>
      ))}
    </div>
  );
}

type RowActions = {
  onReply: (message: MessageRow) => void;
  /** Answering an interactive block (task 2.5); left out when this reader may not. */
  onAct?: ((message: MessageRow, input: BlockAct) => void) | undefined;
  /** The block whose answer is on its way, so it holds still until it lands. */
  acting?: string | null;
  onReact: (message: MessageRow, emoji: string, on: boolean) => void;
  onEdit: (message: MessageRow) => void;
  onDelete: (message: MessageRow) => void;
  onPin: (message: MessageRow) => void;
  onBookmark: (message: MessageRow) => void;
  onHistory: (message: MessageRow) => void;
  canDelete: (message: MessageRow) => boolean;
  mine: (message: MessageRow) => boolean;
};

function MessageItem(props: {
  row: MessageRow;
  actions: RowActions;
  inThread: boolean;
  cards: Map<string, UnfurlCard>;
}) {
  const { row, actions } = props;
  const [picking, setPicking] = useState(false);
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
        {row.author_type === "bot" ? <BotBadge /> : null}
        <span className="text-sm text-fg-subtle">{when(row.created_at)}</span>
        {row.pinned ? <Badge tone="accent">{t("chat.pinned")}</Badge> : null}
        {row.bookmarked ? <Badge>{t("chat.saved")}</Badge> : null}
      </div>
      <Blocks
        blocks={row.blocks}
        files={row.files}
        {...(actions.onAct ? { onAct: (input: BlockAct) => actions.onAct?.(row, input) } : {})}
        acting={actions.acting ?? null}
      />
      <Unfurls row={row} cards={props.cards} />
      <Reactions row={row} onReact={actions.onReact} />
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
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={picking}
          onClick={() => setPicking((open) => !open)}
        >
          {t("chat.react")}
        </Button>
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

      {/* The quick picker, opened from the toolbar and closed by choosing or by Escape. */}
      {picking ? (
        <div
          role="toolbar"
          aria-label={t("chat.reactWith")}
          className="absolute top-8 right-1 z-10 flex gap-1 rounded border border-border bg-surface p-1 shadow-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") setPicking(false);
          }}
        >
          {QUICK.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="rounded px-1 text-md hover:bg-surface-2"
              aria-label={t("chat.reactWithEmoji", { emoji })}
              onClick={() => {
                setPicking(false);
                actions.onReact(
                  row,
                  emoji,
                  !row.reactions.some((p) => p.emoji === emoji && p.mine),
                );
              }}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** The channel's own flow, virtualized, following the end while the reader is at the end. */
function Flow(props: {
  rows: MessageRow[];
  actions: RowActions;
  label: string;
  cards: Map<string, UnfurlCard>;
}) {
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
                <MessageItem
                  row={row}
                  actions={props.actions}
                  inThread={false}
                  cards={props.cards}
                />
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
   * Every message.* and reaction.* on this workspace's topic is a reason to look again, and so is
   * a channel.*: somebody who just joined has to be in the mention list before anybody names them.
   */
  useEffect(() => {
    const socket = getSocket();
    socket.subscribe(`ws:${props.workspaceId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic !== `ws:${props.workspaceId}`) return;
      if (envelope.type.startsWith("message.") || envelope.type.startsWith("reaction.")) {
        void invalidate();
      }
      // A hop, or the breaker: the thread's header says what the bots have been doing (task 2.7).
      if (envelope.type.startsWith("bot.") || envelope.type.startsWith("thread.")) {
        void queryClient.invalidateQueries({
          queryKey: ["workspace", props.workspaceId, "chain"],
        });
      }
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

  const attach = useMutation({
    mutationFn: async (file: File) => {
      // Multipart, so this one goes out as a plain fetch rather than through the typed client.
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/workspaces/${props.workspaceId}/files`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        throw new RequestFailed(res.status, (await res.json().catch(() => undefined)) as never);
      }
      const uploaded = (await res.json()) as { id: string };
      return unwrap(
        await api.POST("/api/workspaces/{ws}/channels/{channel}/messages", {
          params: { path: { ws: props.workspaceId, channel: props.channelId } },
          body: { blocks: [{ type: "file", fileId: uploaded.id }] },
        }),
      );
    },
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const reaction = useMutation({
    mutationFn: async (input: { id: string; emoji: string; on: boolean }) => {
      if (input.on) {
        return unwrap(
          await api.POST("/api/workspaces/{ws}/messages/{message}/reactions", {
            params: { path: { ws: props.workspaceId, message: input.id } },
            body: { emoji: input.emoji },
          }),
        );
      }
      return unwrap(
        await api.DELETE("/api/workspaces/{ws}/messages/{message}/reactions/{emoji}", {
          params: { path: { ws: props.workspaceId, message: input.id, emoji: input.emoji } },
        }),
      );
    },
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  // Answering an interactive block (task 2.5): the api writes the answer into the block and tells
  // whoever owns it, so the refetch brings back the message with its own outcome in it.
  const [acting, setActing] = useState<string | null>(null);
  const interact = useMutation({
    mutationFn: async (input: { id: string; act: BlockAct }) => {
      setActing(input.act.blockId);
      return unwrap(
        await api.POST("/api/workspaces/{ws}/messages/{message}/interactions", {
          params: { path: { ws: props.workspaceId, message: input.id } },
          body: { block_id: input.act.blockId, values: input.act.values },
        }),
      );
    },
    onSuccess: async () => {
      setError(null);
      setActing(null);
      await invalidate();
    },
    onError: (err: unknown) => {
      setActing(null);
      setError(message(err));
    },
  });

  // Which bots have answered in this thread, how far it went, and what it cost (task 2.7).
  const chain = useQuery({
    queryKey: ["workspace", props.workspaceId, "chain", threadRoot],
    enabled: Boolean(threadRoot),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/messages/{message}/chain", {
          params: { path: { ws: props.workspaceId, message: threadRoot ?? "" } },
        }),
      ),
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
    onReact: (row, emoji, on) => reaction.mutate({ id: row.id, emoji, on }),
    onEdit: (row) => setEditing(row),
    onDelete: (row) => remove.mutate(row.id),
    onPin: (row) => patch.mutate({ id: row.id, body: { pinned: !row.pinned } }),
    onBookmark: (row) => patch.mutate({ id: row.id, body: { bookmarked: !row.bookmarked } }),
    onHistory: (row) => setHistoryOf((current) => (current === row.id ? null : row.id)),
    // A reader watches the block; only somebody in the channel may answer it.
    ...(props.member
      ? { onAct: (row: MessageRow, act: BlockAct) => interact.mutate({ id: row.id, act }) }
      : {}),
    acting,
    canDelete: (row) => props.canModerate || (row.author_type === "user" && row.author_id === myId),
    mine: (row) => row.author_type === "user" && row.author_id === myId,
  };

  /**
   * One ask for every identifier on screen, rather than one per message: a page of chat is a page
   * of reads, and the api answers only with what this reader could have opened anyway.
   */
  const identifiers = useMemo(() => {
    const found: string[] = [];
    for (const row of [...rows, ...replies]) {
      for (const block of row.blocks) {
        for (const identifier of identifiersIn(String(block.text ?? ""))) {
          if (!found.includes(identifier)) found.push(identifier);
        }
      }
    }
    return found.slice(0, 20);
  }, [rows, replies]);

  const unfurls = useQuery({
    queryKey: ["workspace", props.workspaceId, "unfurl", identifiers.join(" ")],
    enabled: identifiers.length > 0,
    queryFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/unfurl", {
          params: { path: { ws: props.workspaceId } },
          body: { identifiers },
        }),
      ),
  });

  const cards = useMemo(
    () => new Map((unfurls.data?.cards ?? []).map((card) => [card.identifier, card])),
    [unfurls.data],
  );

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
      <Flow
        rows={rows}
        actions={actions}
        cards={cards}
        label={t("chat.flowOf", { name: props.channelName })}
      />

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
          <label className="mb-1 flex items-center gap-2 text-sm text-fg-muted">
            {t("chat.attach")}
            <input
              type="file"
              data-testid="attach"
              aria-label={t("chat.attach")}
              className="min-w-0 flex-1 text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) attach.mutate(file);
              }}
            />
          </label>
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
            {chain.data && chain.data.hops.length > 0 ? (
              <div className="mb-1">
                <ChainHeader
                  hops={chain.data.hops.map(
                    (hop): ChainHop => ({
                      hop: hop.hop,
                      fromName: hop.from_name,
                      toName: hop.to_name,
                      mode: hop.mode,
                    }),
                  )}
                  costUsd={chain.data.cost_usd}
                  stopped={chain.data.stopped}
                  breaker={chain.data.breaker}
                />
              </div>
            ) : null}
            {replies.map((row) => (
              <MessageItem key={row.id} row={row} actions={actions} inThread cards={cards} />
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
