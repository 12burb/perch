/**
 * The Search mode (spec §5.2 "Search: Postgres full-text over messages and files with filters",
 * §4 "Peek everywhere"; task 2.4).
 *
 * One box, both kinds of result, and the filters a person reaches for. A result opens as a peek —
 * the message with the words that matched, and "Open full" to go to where it was said — because
 * jumping straight out of a list of results loses the list.
 */
import "@perch/ui/i18n/chat";
import { Badge, Button, EmptyState, Input, Peek, t } from "@perch/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "../lib/api.ts";
import { channelsQuery } from "../lib/queries.ts";

type SearchType = "all" | "messages" | "files";

export type MessageHit = {
  id: string;
  channel_id: string;
  channel_name: string | null;
  author_name: string | null;
  blocks: { type: string; text?: string; code?: string }[];
  created_at: string;
};

/** The words of a query, for marking them in a result. Quotes and `-not` are not words. */
export function queryWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
}

/** The text of a message, with the searched words marked where they appear. */
export function Marked(props: { text: string; words: string[] }) {
  if (props.words.length === 0) return <>{props.text}</>;
  const pattern = new RegExp(`(${props.words.map(escapeWord).join("|")})`, "ig");
  const parts = props.text.split(pattern);
  return (
    <>
      {parts.map((part, index) =>
        props.words.includes(part.toLowerCase()) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line have no id
          <mark key={index} className="rounded bg-accent-soft px-0.5 text-accent">
            {part}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line have no id
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function escapeWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textOf(hit: MessageHit): string {
  return hit.blocks
    .map((block) => block.text ?? block.code ?? "")
    .join(" ")
    .trim();
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SearchMain(props: { workspaceId: string; workspaceSlug: string }) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [type, setType] = useState<SearchType>("all");
  const [channel, setChannel] = useState("");
  const [peeked, setPeeked] = useState<MessageHit | null>(null);
  const channels = useQuery(channelsQuery(props.workspaceId)).data ?? [];

  // Typing is not a query until it stops: one request per pause, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);

  const results = useQuery({
    queryKey: ["workspace", props.workspaceId, "search", q, type, channel],
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/search", {
          params: {
            path: { ws: props.workspaceId },
            query: {
              q,
              type,
              ...(channel ? { channel } : {}),
              limit: 50,
            },
          },
        }),
      ),
  });

  const words = queryWords(q);
  const messages = (results.data?.messages ?? []) as MessageHit[];
  const files = results.data?.files ?? [];
  const nothing = q.length >= 2 && !results.isFetching && messages.length + files.length === 0;

  return (
    <section aria-labelledby="search-heading" className="flex min-h-0 flex-1 flex-col p-4">
      <h2 id="search-heading" className="sr-only">
        {t("search.heading")}
      </h2>
      <form
        aria-label={t("search.heading")}
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(typed.trim());
        }}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
          <label htmlFor="search-q" className="text-fg-muted">
            {t("search.label")}
          </label>
          <Input
            id="search-q"
            type="search"
            name="q"
            autoComplete="off"
            placeholder={t("shell.search.placeholder")}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="search-type" className="text-fg-muted">
            {t("search.kind")}
          </label>
          <select
            id="search-type"
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value as SearchType)}
            className="min-h-row rounded border border-border bg-surface px-2 text-md"
          >
            <option value="all">{t("search.kind.all")}</option>
            <option value="messages">{t("search.kind.messages")}</option>
            <option value="files">{t("search.kind.files")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="search-channel" className="text-fg-muted">
            {t("search.inChannel")}
          </label>
          <select
            id="search-channel"
            name="channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="min-h-row rounded border border-border bg-surface px-2 text-md"
          >
            <option value="">{t("search.anyChannel")}</option>
            {channels
              .filter((row) => row.name)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  #{row.name}
                </option>
              ))}
          </select>
        </div>
      </form>

      {q.length < 2 ? (
        <EmptyState
          icon={<Search className="size-8" aria-hidden="true" />}
          title={t("search.emptyTitle")}
          hint={t("search.emptyHint")}
        />
      ) : nothing ? (
        <EmptyState
          icon={<Search className="size-8" aria-hidden="true" />}
          title={t("search.noneTitle", { q })}
          hint={t("search.noneHint")}
        />
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4">
          {messages.length > 0 ? (
            <Hits
              hits={messages}
              words={words}
              label={t("search.messages", { count: messages.length })}
              onPeek={setPeeked}
            />
          ) : null}
          {files.length > 0 ? (
            <section aria-label={t("search.files", { count: files.length })}>
              <h3 className="mb-1 text-sm font-semibold text-fg-muted">
                {t("search.files", { count: files.length })}
              </h3>
              <ul className="flex flex-col gap-1">
                {files.map((hit) => (
                  <li key={hit.file.id}>
                    <a
                      href={`/api/files/${hit.file.id}`}
                      download={hit.file.name}
                      data-testid="file-hit"
                      className="flex items-center gap-2 rounded border border-border bg-raised p-2 text-sm hover:bg-surface-2"
                    >
                      <span className="truncate font-medium">
                        <Marked text={hit.file.name} words={words} />
                      </span>
                      {hit.channel_name ? <Badge>#{hit.channel_name}</Badge> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      <Peek
        open={peeked !== null}
        onOpenChange={(open) => {
          if (!open) setPeeked(null);
        }}
        title={
          peeked
            ? t("search.peekTitle", {
                name: peeked.author_name ?? t("chat.someone"),
                channel: peeked.channel_name ?? "",
              })
            : ""
        }
        identifier={peeked ? `message:${peeked.id}` : undefined}
        fullHref={peeked ? `/${props.workspaceSlug}/home/${peeked.channel_id}` : undefined}
      >
        {peeked ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-fg-muted">{when(peeked.created_at)}</p>
            <p className="whitespace-pre-wrap break-words text-md" data-testid="peek-text">
              <Marked text={textOf(peeked)} words={words} />
            </p>
          </div>
        ) : null}
      </Peek>
    </section>
  );
}

/** The message results, virtualized: a busy workspace answers with a hundred of them. */
function Hits(props: {
  hits: MessageHit[];
  words: string[];
  label: string;
  onPeek: (hit: MessageHit) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.hits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    overscan: 8,
    getItemKey: (index) => props.hits[index]?.id ?? index,
  });
  return (
    <section aria-label={props.label} className="flex min-h-0 flex-1 flex-col">
      <h3 className="mb-1 text-sm font-semibold text-fg-muted">{props.label}</h3>
      <div ref={parentRef} data-testid="search-results" className="min-h-0 flex-1 overflow-auto">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const hit = props.hits[item.index];
            if (!hit) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute top-0 left-0 w-full pb-1"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <Button
                  variant="ghost"
                  data-testid="search-hit"
                  className="h-auto w-full flex-col items-start gap-1 rounded border border-border bg-raised p-2 text-left"
                  onClick={() => props.onPeek(hit)}
                >
                  <span className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                    <span className="font-medium text-fg">
                      {hit.author_name ?? t("chat.someone")}
                    </span>
                    {hit.channel_name ? <Badge>#{hit.channel_name}</Badge> : null}
                    <span>{when(hit.created_at)}</span>
                  </span>
                  <span className="line-clamp-2 whitespace-pre-wrap break-words text-md">
                    <Marked text={textOf(hit)} words={props.words} />
                  </span>
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
