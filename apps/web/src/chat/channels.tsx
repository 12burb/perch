/**
 * Channels in Home mode (spec §4 sidebar sections, §5.2; task 2.1).
 *
 * Three pieces: the sidebar sections, where a channel's weight is what is unread in it; the browser
 * in main, which is how a channel is started and joined; and the channel itself, with its header,
 * its people, and the buttons that take you out of it or put it away. Messages are task 2.2, so the
 * channel's body is an empty state that says so in the plainest way there is.
 */
import "@perch/ui/i18n/chat";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  type MessageKey,
  SidebarItem,
  SidebarSection,
  t,
} from "@perch/ui";
import { VirtualList } from "@perch/ui/virtual-list";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  botsQuery,
  type ChannelRow,
  channelMembersQuery,
  channelsQuery,
  type MyWorkspace,
  meQuery,
} from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";
import { botChats } from "./chats.ts";
import { ChannelTranscript } from "./transcript.tsx";

function message(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

/** Refetches the channels whenever a channel.* event arrives on the workspace topic. */
export function useLiveChannels(workspaceId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    const socket = getSocket();
    socket.subscribe(`ws:${workspaceId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic === `ws:${workspaceId}` && envelope.type.startsWith("channel.")) {
        void queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId, "channels"] });
      }
    });
  }, [workspaceId, queryClient]);
}

/** Unread first, then alphabetical: the sidebar's weight is what is waiting for you (spec §5.2). */
export function byWeight(a: ChannelRow, b: ChannelRow): number {
  if (a.unread !== b.unread) return b.unread - a.unread;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

function ChannelLink(props: { workspaceSlug: string; channel: ChannelRow; active: boolean }) {
  const { channel } = props;
  return (
    <SidebarItem
      label={`#${channel.name ?? t("chat.private")}`}
      href={`/${props.workspaceSlug}/home/${channel.id}`}
      active={props.active}
      unread={channel.unread}
    />
  );
}

/**
 * How many rows a sidebar section renders (spec §4 "every long list is virtualized"; ADR-0113).
 * The sidebar is one scroll container for every section, so a section cannot own a virtual window
 * without nesting scrollers. It shows the most relevant rows instead, and says how many it is not
 * showing — the whole list is a click away in Home, virtualized.
 */
export const SIDEBAR_ROWS = 30;

/** The rows a section shows, and how many it left out. */
export function sidebarWindow<T>(rows: readonly T[]): { shown: readonly T[]; more: number } {
  return rows.length <= SIDEBAR_ROWS
    ? { shown: rows, more: 0 }
    : { shown: rows.slice(0, SIDEBAR_ROWS), more: rows.length - SIDEBAR_ROWS };
}

/** The last row of a capped section: what is not shown, and where the rest of it is. */
function MoreRow(props: { more: number; workspaceSlug?: string }) {
  if (props.more === 0) return null;
  return (
    <li className="px-2 py-1 text-sm text-fg-subtle" data-testid="sidebar-more">
      {props.workspaceSlug ? (
        <Link
          to="/$workspace/$mode"
          params={{ workspace: props.workspaceSlug, mode: "home" }}
          className="underline"
        >
          {t("chat.seeAll", { count: props.more + SIDEBAR_ROWS })}
        </Link>
      ) : (
        t("chat.more", { count: props.more })
      )}
    </li>
  );
}

/** Home's Channels section: the named rooms this member is in. */
export function ChannelsSection(props: { workspace: MyWorkspace }) {
  useLiveChannels(props.workspace.id);
  const params = useParams({ strict: false }) as { channel?: string };
  const channels = useQuery(channelsQuery(props.workspace.id)).data ?? [];
  const mine = channels
    .filter((c) => c.member && !c.archived && (c.type === "public" || c.type === "private"))
    .sort(byWeight);
  const { shown, more } = sidebarWindow(mine);
  return (
    <SidebarSection title={t("shell.home.channels")}>
      {mine.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("chat.channelsEmpty")}</li>
      ) : (
        shown.map((channel) => (
          <ChannelLink
            key={channel.id}
            workspaceSlug={props.workspace.slug}
            channel={channel}
            active={params.channel === channel.id}
          />
        ))
      )}
      <MoreRow more={more} workspaceSlug={props.workspace.slug} />
    </SidebarSection>
  );
}

/** Home's Direct messages section: the rooms named by who is in them. */
export function DirectMessagesSection(props: { workspace: MyWorkspace }) {
  const params = useParams({ strict: false }) as { channel?: string };
  const channels = useQuery(channelsQuery(props.workspace.id)).data ?? [];
  const bots = useQuery(botsQuery(props.workspace.id)).data ?? [];
  // A chat with a bot is in the Bots section instead, where it is named by the bot.
  const withBots = new Set([...botChats(bots, channels).values()].map((room) => room.id));
  const mine = channels
    .filter(
      (c) =>
        c.member && !c.archived && (c.type === "dm" || c.type === "group") && !withBots.has(c.id),
    )
    .sort(byWeight);
  const { shown, more } = sidebarWindow(mine);
  return (
    <SidebarSection title={t("shell.home.dms")}>
      {mine.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("chat.dmsEmpty")}</li>
      ) : (
        shown.map((channel) => (
          <ChannelLink
            key={channel.id}
            workspaceSlug={props.workspace.slug}
            channel={channel}
            active={params.channel === channel.id}
          />
        ))
      )}
      <MoreRow more={more} />
    </SidebarSection>
  );
}

/**
 * Home's Bots section (spec §4 "sidebar Channels/DMs/Bots/Later"): the bots this workspace can talk
 * to, each one a chat of your own. Opening it makes the room the first time and finds it after
 * (task 2.9).
 */
export function BotsSection(props: { workspace: MyWorkspace; empty: MessageKey }) {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { channel?: string };
  const bots = useQuery(botsQuery(props.workspace.id)).data ?? [];
  const channels = useQuery(channelsQuery(props.workspace.id)).data ?? [];
  const talkable = bots.filter((bot) => bot.status !== "disabled");
  const chats = botChats(talkable, channels);
  const open = useMutation({
    mutationFn: async (botId: string) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/bots/{bot}/dm", {
          params: { path: { ws: props.workspace.id, bot: botId } },
        }),
      ),
    onSuccess: async (chat) => {
      await navigate({
        to: "/$workspace/home/$channel",
        params: { workspace: props.workspace.slug, channel: chat.channel_id },
      });
    },
  });
  return (
    <SidebarSection title={t("shell.home.bots")}>
      {talkable.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t(props.empty)}</li>
      ) : (
        sidebarWindow(talkable).shown.map((bot) => {
          // Once the chat exists it is a room like any other, with what is waiting for you in it.
          const chat = chats.get(bot.id);
          return (
            <SidebarItem
              key={bot.id}
              label={`@${bot.handle}`}
              active={chat !== undefined && params.channel === chat.id}
              {...(chat
                ? {
                    href: `/${props.workspace.slug}/home/${chat.id}`,
                    ...(chat.unread ? { unread: chat.unread } : {}),
                  }
                : { onSelect: () => open.mutate(bot.id) })}
            />
          );
        })
      )}
      <MoreRow more={sidebarWindow(talkable).more} />
    </SidebarSection>
  );
}

/** The browser in Home's main: every channel this member can see, and the form that starts one. */
export function ChannelsMain(props: { workspaceId: string; workspaceSlug: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useLiveChannels(props.workspaceId);
  const channels = useQuery(channelsQuery(props.workspaceId)).data ?? [];
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const formId = useId();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "channels"] });

  const create = useMutation({
    mutationFn: async (body: { name: string; topic: string }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/channels", {
          params: { path: { ws: props.workspaceId } },
          body: { type: visibility, name: body.name, ...(body.topic ? { topic: body.topic } : {}) },
        }),
      ),
    onSuccess: async (channel) => {
      setError(null);
      await invalidate();
      await navigate({
        to: "/$workspace/home/$channel",
        params: { workspace: props.workspaceSlug, channel: channel.id },
      });
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const join = useMutation({
    mutationFn: async (channelId: string) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/channels/{channel}/members", {
          params: { path: { ws: props.workspaceId, channel: channelId } },
          body: {},
        }),
      ),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    create.mutate({ name, topic: String(data.get("topic") ?? "").trim() });
    event.currentTarget.reset();
  };

  const open = channels.filter((channel) => !channel.archived);
  return (
    <section
      aria-labelledby="channels-heading"
      className="flex flex-col gap-4 border-b border-border p-4"
    >
      <div className="flex flex-col gap-2">
        {/* Named apart from the sidebar's Channels section: two landmarks may not share a name. */}
        <h2 id="channels-heading" className="text-md font-semibold">
          {t("chat.allChannels")}
        </h2>
        {open.length === 0 ? (
          // A live region, like every other mode's empty state: it is the whole of Home until a
          // channel exists.
          <p role="status" className="text-sm text-fg-subtle">
            {t("chat.channelsEmpty")}
          </p>
        ) : (
          // A workspace's channels have no ceiling, so the list renders its window (ADR-0113).
          <VirtualList
            rows={open.sort(byWeight)}
            label={t("chat.allChannels")}
            keyOf={(channel) => channel.id}
            estimateSize={40}
            className="max-h-[60vh]"
          >
            {(channel) => (
              <div
                data-testid="channel-row"
                className="flex items-center gap-2 rounded border border-border px-2 py-1"
              >
                <Link
                  to="/$workspace/home/$channel"
                  params={{ workspace: props.workspaceSlug, channel: channel.id }}
                  className="min-w-0 flex-1 truncate text-sm"
                  aria-label={t("chat.open", { name: channel.name ?? t("chat.private") })}
                >
                  <span aria-hidden="true" className="text-fg-subtle">
                    #
                  </span>
                  {channel.name ?? t("chat.private")}
                </Link>
                {channel.type === "private" ? <Badge>{t("chat.private")}</Badge> : null}
                <span className="text-sm text-fg-muted">
                  {t("chat.members", { count: channel.member_count })}
                </span>
                {channel.member ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={join.isPending}
                    onClick={() => join.mutate(channel.id)}
                  >
                    {join.isPending ? t("chat.joining") : t("chat.join")}
                  </Button>
                )}
              </div>
            )}
          </VirtualList>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        aria-label={t("chat.newChannelHeading")}
        className="flex flex-col gap-2"
      >
        <h3 className="text-sm font-semibold">{t("chat.newChannelHeading")}</h3>
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${formId}-name`} label={t("chat.name")} hint={t("chat.nameHint")}>
            {(control) => (
              <Input {...control} name="name" required maxLength={80} autoComplete="off" />
            )}
          </Field>
          <Field id={`${formId}-topic`} label={t("chat.topic")}>
            {(control) => <Input {...control} name="topic" maxLength={1000} autoComplete="off" />}
          </Field>
          <Field id={`${formId}-visibility`} label={t("chat.visibility")}>
            {(control) => (
              <select
                {...control}
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as "public" | "private")}
                className="min-h-row rounded border border-border bg-surface px-2 text-md"
              >
                <option value="public">{t("chat.visibility.public")}</option>
                <option value="private">{t("chat.visibility.private")}</option>
              </select>
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? t("chat.creating") : t("chat.create")}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

/** One channel: its header, who is in it, and — until task 2.2 — a room with nothing said in it. */
export function ChannelView(props: {
  workspaceId: string;
  workspaceSlug: string;
  channelId: string;
  canArchive: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useLiveChannels(props.workspaceId);
  const channels = useQuery(channelsQuery(props.workspaceId));
  const channel = (channels.data ?? []).find((row) => row.id === props.channelId) ?? null;
  const members = useQuery(channelMembersQuery(props.workspaceId, props.channelId));
  const me = useQuery(meQuery);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const topicId = useId();

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "channels"] });
  };

  const patch = useMutation({
    mutationFn: async (body: { topic?: string; archived?: boolean }) =>
      unwrap(
        await api.PATCH("/api/workspaces/{ws}/channels/{channel}", {
          params: { path: { ws: props.workspaceId, channel: props.channelId } },
          body,
        }),
      ),
    onSuccess: async () => {
      setError(null);
      setTopic(null);
      await invalidate();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const join = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/channels/{channel}/members", {
          params: { path: { ws: props.workspaceId, channel: props.channelId } },
          body: {},
        }),
      ),
    onSuccess: async () => {
      setError(null);
      await invalidate();
      await members.refetch();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const leave = useMutation({
    // Leaving answers 204, which has no body to unwrap.
    mutationFn: async (userId: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/channels/{channel}/members/{user}", {
        params: { path: { ws: props.workspaceId, channel: props.channelId, user: userId } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
      return userId;
    },
    onSuccess: async () => {
      setError(null);
      await invalidate();
      await navigate({
        to: "/$workspace/$mode",
        params: { workspace: props.workspaceSlug, mode: "home" },
      });
    },
    onError: (err: unknown) => setError(message(err)),
  });

  if (channels.isLoading) return null;
  if (!channel) {
    return <EmptyState title={t("chat.notFound")} hint={t("chat.notFoundHint")} />;
  }

  const myId = me.data?.id ?? "";
  return (
    <section aria-label={`#${channel.name ?? t("chat.private")}`} className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        {/* The hash is part of the name, so it is in the heading's text and not decoration. */}
        <h2 className="text-md font-semibold">{`#${channel.name ?? t("chat.private")}`}</h2>
        {channel.archived ? <Badge tone="warning">{t("chat.archived")}</Badge> : null}
        {channel.type === "private" ? <Badge>{t("chat.private")}</Badge> : null}
        <span className="text-sm text-fg-muted" data-testid="channel-members">
          {t("chat.members", { count: channel.member_count })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {channel.member ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={leave.isPending || !myId}
              onClick={() => myId && leave.mutate(myId)}
            >
              {t("chat.leave")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={join.isPending || channel.archived}
              onClick={() => join.mutate()}
            >
              {join.isPending ? t("chat.joining") : t("chat.join")}
            </Button>
          )}
          {props.canArchive ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ archived: !channel.archived })}
            >
              {channel.archived ? t("chat.unarchive") : t("chat.archive")}
            </Button>
          ) : null}
        </div>
      </header>

      <form
        className="flex items-end gap-2 border-b border-border p-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          patch.mutate({ topic: topic ?? "" });
        }}
      >
        <Field id={topicId} label={t("chat.topic")}>
          {(control) => (
            <Input
              {...control}
              value={topic ?? channel.topic ?? ""}
              placeholder={t("chat.topicPlaceholder")}
              maxLength={1000}
              onChange={(event) => setTopic(event.target.value)}
              className="w-64"
            />
          )}
        </Field>
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={topic === null || patch.isPending}
        >
          {t("chat.topicSave")}
        </Button>
      </form>

      {channel.member ? null : (
        <div className="p-3">
          <EmptyState title={t("chat.notMember")} hint={t("chat.notMemberHint")} />
        </div>
      )}
      <ChannelTranscript
        workspaceId={props.workspaceId}
        channelId={props.channelId}
        channelName={channel.name ?? t("chat.private")}
        canModerate={props.canArchive}
        member={channel.member}
      />

      <div className="border-t border-border p-3">
        <h3 className="text-sm font-semibold">{t("chat.membersHeading")}</h3>
        <ul aria-label={t("chat.membersHeading")} className="flex flex-wrap gap-2 pt-1">
          {(members.data ?? []).map((row) => (
            <li key={row.member_id} className="rounded border border-border px-2 py-0.5 text-sm">
              {row.name ?? row.member_id}
            </li>
          ))}
        </ul>
      </div>

      {error ? (
        <p role="alert" className="p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
