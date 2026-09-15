import { t } from "@perch/ui";
import { createFileRoute } from "@tanstack/react-router";
import { ChannelView } from "../../../chat/channels.tsx";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

/** One channel open in Home mode (task 2.1): its header, its people, and what is said in it. */
export const Route = createFileRoute("/_app/$workspace/home/$channel")({
  component: ChannelRoute,
});

function ChannelRoute() {
  const { channel } = Route.useParams();
  const { shell, workspace } = useAppShell();
  if (!workspace) return null;
  return (
    <ModePage title={t("ui.mode.home")} subtitle={workspace.name} shell={shell}>
      <ChannelView
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        channelId={channel}
        canArchive={workspace.role !== "member"}
      />
    </ModePage>
  );
}
