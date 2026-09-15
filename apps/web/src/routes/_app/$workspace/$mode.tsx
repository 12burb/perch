import { Avatar, Badge, EmptyState, type RailMode, t } from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, useSearch } from "@tanstack/react-router";
import { Bot, Code, Inbox, MessageSquare, Search, SquareKanban } from "lucide-react";
import type { ComponentType } from "react";
import { ChannelsMain } from "../../../chat/channels.tsx";
import { SearchMain } from "../../../chat/search.tsx";
import { ProjectsMain } from "../../../code/projects.tsx";
import { type InboxFilter, InboxMain, isFilter } from "../../../inbox/inbox.tsx";
import { membersQuery, meQuery } from "../../../lib/queries.ts";
import { usePresence } from "../../../lib/ws.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

const MODES: RailMode[] = ["home", "code", "work", "bots", "inbox", "search"];

/** One route for the six rail tabs; each mode renders its empty state until its phase lands. */
export const Route = createFileRoute("/_app/$workspace/$mode")({
  beforeLoad: ({ params }) => {
    if (!MODES.includes(params.mode as RailMode)) throw notFound();
    return { mode: params.mode as RailMode };
  },
  component: ModeRoute,
});

const ICONS: Record<RailMode, ComponentType<{ className?: string; "aria-hidden"?: "true" }>> = {
  home: MessageSquare,
  code: Code,
  work: SquareKanban,
  bots: Bot,
  inbox: Inbox,
  search: Search,
};

function ModeRoute() {
  const { mode } = Route.useRouteContext();
  const { shell, workspace } = useAppShell();
  // The Inbox's four sections are the same queue asked for differently, and the ask is in the URL.
  const search = useSearch({ strict: false }) as { filter?: string };
  const filter: InboxFilter = isFilter(search.filter) ? search.filter : "needs-you";
  const me = useQuery(meQuery);
  if (!workspace) return null;
  const Icon = ICONS[mode];
  return (
    <ModePage title={t(`ui.mode.${mode}`)} subtitle={workspace.name} shell={shell}>
      {mode === "home" ? (
        <>
          <ChannelsMain workspaceId={workspace.id} workspaceSlug={workspace.slug} />
          <HomeMain workspaceId={workspace.id} />
        </>
      ) : null}
      {mode === "code" ? (
        <ProjectsMain
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          canAdmin={workspace.role !== "member"}
        />
      ) : null}
      {mode === "search" ? (
        <SearchMain workspaceId={workspace.id} workspaceSlug={workspace.slug} />
      ) : null}
      {mode === "inbox" ? <InboxMain filter={filter} userId={me.data?.id ?? ""} /> : null}
      {mode === "code" || mode === "home" || mode === "search" || mode === "inbox" ? null : (
        <EmptyState
          icon={<Icon className="size-8" aria-hidden="true" />}
          title={t(`shell.${mode}.emptyTitle`)}
          hint={t(`shell.${mode}.emptyHint`)}
        />
      )}
    </ModePage>
  );
}

/** Home also shows the people in the workspace, with live presence (task 0.10). */
function HomeMain(props: { workspaceId: string }) {
  const members = useQuery(membersQuery(props.workspaceId)).data ?? [];
  const presence = usePresence(props.workspaceId);
  const online = [...presence.values()].filter((status) => status === "online").length;
  return (
    <section aria-labelledby="members-heading" className="border-b border-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 id="members-heading" className="text-md font-semibold">
          {t("shell.home.members")}
        </h2>
        <span className="text-sm text-fg-muted" data-testid="online-count" aria-live="polite">
          {t("home.online", { count: online })}
        </span>
      </div>
      <ul aria-label={t("shell.home.members")} className="flex flex-wrap gap-2">
        {members.map((member) => {
          const status = presence.get(member.user_id);
          return (
            <li
              key={member.user_id}
              className="flex items-center gap-2 rounded border border-border px-2 py-1"
            >
              <span className="relative">
                <Avatar name={member.name} size="sm" />
                <span
                  aria-hidden="true"
                  className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border border-surface ${status === "online" ? "bg-success" : status === "away" ? "bg-warning" : "bg-fg-subtle"}`}
                />
              </span>
              <span className="text-sm">{member.name}</span>
              <Badge>{t(`home.role.${member.role}`)}</Badge>
              <span className="sr-only">{status ?? "offline"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
