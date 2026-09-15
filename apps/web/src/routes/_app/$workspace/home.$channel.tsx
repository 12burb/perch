import { t } from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotChat } from "../../../chat/bot-chat.tsx";
import { ChannelView } from "../../../chat/channels.tsx";
import { botDmQuery, botsQuery, channelMembersQuery, channelsQuery } from "../../../lib/queries.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

/** One channel open in Home mode (task 2.1): its header, its people, and what is said in it. */
export const Route = createFileRoute("/_app/$workspace/home/$channel")({
  component: ChannelRoute,
});

function ChannelRoute() {
  const { channel } = Route.useParams();
  const { shell, workspace } = useAppShell();
  const workspaceId = workspace?.id ?? "";
  // A DM with a bot reads as a chat rather than as a room (spec §5.2 "DM-a-bot"; task 2.9).
  const channels = useQuery(channelsQuery(workspaceId)).data ?? [];
  const members = useQuery(channelMembersQuery(workspaceId, channel)).data ?? [];
  const bots = useQuery(botsQuery(workspaceId)).data ?? [];
  const row = channels.find((one) => one.id === channel);
  const botId = members.find((one) => one.member_type === "bot")?.member_id ?? "";
  const bot = row?.type === "dm" ? bots.find((one) => one.id === botId) : undefined;
  const chat = useQuery({ ...botDmQuery(workspaceId, bot ? botId : ""), staleTime: 0 });

  if (!workspace) return null;
  return (
    <ModePage title={t("ui.mode.home")} subtitle={workspace.name} shell={shell}>
      {bot ? (
        <BotChat
          workspaceId={workspace.id}
          channelId={channel}
          bot={bot}
          canPickBrain={chat.data?.can_pick_brain ?? bot.spec.brain?.pick === true}
          brain={chat.data?.brain ?? null}
        />
      ) : (
        <ChannelView
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          channelId={channel}
          canArchive={workspace.role !== "member"}
        />
      )}
    </ModePage>
  );
}
