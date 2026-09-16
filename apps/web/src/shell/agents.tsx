/**
 * The floor (spec §5.7 "agent presence: busy/idle, 'working on' cards, agent org view"; task
 * 3.19): every session and every bot working right now, oldest first, each with the one button
 * that stops it.
 *
 * It is live because the things it lists are: a session changing status and a bot run starting or
 * finishing both land on the workspace topic, and each of them means this list is out of date.
 */
import { Badge, Button, SidebarSection, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { agentsQuery } from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";

/** What a row's state is called, and how loudly. */
const TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  running: "success",
  needs_you: "warning",
  error: "danger",
};

function useLiveAgents(workspaceId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    const socket = getSocket();
    socket.subscribe(`ws:${workspaceId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic !== `ws:${workspaceId}`) return;
      const about =
        envelope.type.startsWith("session.") ||
        envelope.type.startsWith("bot.run_") ||
        envelope.type === "agent.stopped";
      if (!about) return;
      void queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId, "agents"] });
    });
  }, [queryClient, workspaceId]);
}

export function AgentsSection(props: { workspaceId: string }) {
  const agents = useQuery(agentsQuery(props.workspaceId));
  const queryClient = useQueryClient();
  useLiveAgents(props.workspaceId);
  const stop = useMutation({
    mutationFn: async (row: { kind: "session" | "bot"; id: string }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/agents/{kind}/{id}/stop", {
          params: { path: { ws: props.workspaceId, kind: row.kind, id: row.id } },
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "agents"] }),
  });
  const rows = agents.data?.agents ?? [];

  return (
    <SidebarSection title={t("shell.bots.agents")}>
      {rows.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("shell.bots.agentsEmpty")}</li>
      ) : (
        rows.map((row) => (
          <li
            key={`${row.kind}:${row.id}`}
            data-testid="agent-row"
            className="flex items-center gap-2 px-2 py-1"
          >
            <a
              href={row.url}
              className="flex min-w-0 flex-1 flex-col gap-0.5 hover:underline"
              title={row.title}
            >
              <span className="truncate text-sm">{row.title}</span>
              <span className="flex items-center gap-1 text-xs text-fg-subtle">
                <Badge tone={TONE[row.state] ?? "neutral"}>
                  {t(`agents.state.${row.state}` as "agents.state.running")}
                </Badge>
                <span className="truncate">
                  {row.kind === "session"
                    ? (row.project?.key ?? row.engine ?? "")
                    : (row.bot?.handle ?? "")}
                </span>
              </span>
            </a>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("agents.stopOne", { name: row.title })}
              disabled={stop.isPending}
              onClick={() => stop.mutate({ kind: row.kind, id: row.id })}
            >
              {t("agents.stop")}
            </Button>
          </li>
        ))
      )}
      {stop.error ? (
        <li role="alert" className="px-2 py-1 text-sm text-danger">
          {stop.error instanceof RequestFailed ? stop.error.message : t("common.error")}
        </li>
      ) : null}
    </SidebarSection>
  );
}
