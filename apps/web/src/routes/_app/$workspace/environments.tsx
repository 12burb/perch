import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { api, RequestFailed, unwrap } from "../../../lib/api.ts";
import { type RunnerRow, runnersQuery } from "../../../lib/queries.ts";
import { getSocket } from "../../../lib/ws.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

/**
 * The Environments page (spec §3.2, task 1.3): the workspace's runners with live status, a form that
 * registers a machine of your own and shows the connect command once, and removal.
 */
export const Route = createFileRoute("/_app/$workspace/environments")({ component: Environments });

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

function Environments() {
  const { shell, workspace, me } = useAppShell();
  if (!workspace) return null;
  return (
    <ModePage title={t("environments.title")} subtitle={t("environments.subtitle")} shell={shell}>
      <div className="flex flex-col gap-8 p-4">
        <RunnerList
          workspaceId={workspace.id}
          myId={me.id}
          canAdmin={workspace.role !== "member"}
        />
        <ConnectSection workspaceId={workspace.id} />
      </div>
    </ModePage>
  );
}

/** Refetches the list whenever a runner.* event arrives on the workspace topic. */
function useLiveRunners(workspaceId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    socket.subscribe(`ws:${workspaceId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic === `ws:${workspaceId}` && envelope.type.startsWith("runner.")) {
        void queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId, "runners"] });
      }
    });
  }, [queryClient, workspaceId]);
}

function kindLabel(runner: RunnerRow): string {
  if (runner.workspace_id === null) return t("environments.kind.shared");
  return t(`environments.kind.${runner.kind}`);
}

function RunnerList(props: { workspaceId: string; myId: string; canAdmin: boolean }) {
  useLiveRunners(props.workspaceId);
  const queryClient = useQueryClient();
  const runners = useQuery(runnersQuery(props.workspaceId));
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: async (runnerId: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/runners/{runner}", {
        params: { path: { ws: props.workspaceId, runner: runnerId } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
      return runnerId;
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "runners"],
      });
    },
    onError: (err) => setError(message(err)),
  });
  const rows = runners.data ?? [];
  if (runners.isSuccess && rows.length === 0) {
    return <EmptyState title={t("environments.empty")} hint={t("environments.emptyHint")} />;
  }
  return (
    <section aria-labelledby="runners-heading" className="flex flex-col gap-3">
      <h2 id="runners-heading" className="text-md font-semibold">
        {t("environments.title")}
      </h2>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <table className="w-full table-fixed text-sm break-words">
          <thead>
            <tr className="text-left text-fg-muted">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("environments.machineName")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("environments.status")}
              </th>
              <th scope="col" className="hidden py-1 pr-3 font-medium sm:table-cell">
                {t("environments.kind")}
              </th>
              <th scope="col" className="hidden py-1 pr-3 font-medium sm:table-cell">
                {t("environments.lastSeen")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                <span className="sr-only">{t("settings.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((runner) => {
              const mine = runner.owner_user_id === props.myId;
              const online = runner.connected;
              return (
                <tr key={runner.id} className="border-t border-border" data-testid="runner-row">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{runner.name}</span>
                    {mine ? <Badge className="ml-2">{t("environments.you")}</Badge> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={online ? "success" : "neutral"} data-testid="runner-status">
                      {online ? t("environments.status.online") : t("environments.status.offline")}
                    </Badge>
                    {online && runner.sessions > 0 ? (
                      <span className="ml-2 text-fg-muted">
                        {t("environments.sessions", { count: runner.sessions })}
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden py-2 pr-3 sm:table-cell">
                    {kindLabel(runner)}
                    {runner.platform ? (
                      <span className="ml-1 text-fg-muted">
                        {runner.platform}/{runner.arch ?? "?"}
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden py-2 pr-3 text-fg-muted sm:table-cell">
                    {runner.last_seen_at
                      ? new Date(runner.last_seen_at).toLocaleString()
                      : t("environments.never")}
                  </td>
                  <td className="py-2 text-right">
                    {mine || props.canAdmin ? (
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={t("environments.removeOf", { name: runner.name })}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(runner.id)}
                      >
                        {t("environments.remove")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConnectSection(props: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const connect = useMutation({
    mutationFn: async (body: { name: string }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/runners/connect", {
          params: { path: { ws: props.workspaceId } },
          body,
        }),
      ),
    onSuccess: async (created) => {
      setError(null);
      setCopied(false);
      setCommand(created.command);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "runners"],
      });
    },
    onError: (err) => setError(message(err)),
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    connect.mutate({ name }, { onSuccess: () => form.reset() });
  }
  async function copy() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <section aria-labelledby="connect-heading" className="flex max-w-2xl flex-col gap-3">
      <h2 id="connect-heading" className="text-md font-semibold">
        {t("environments.connectHeading")}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field id="machine-name" label={t("environments.machineName")} error={error}>
          {(control) => (
            <Input {...control} name="name" required maxLength={80} autoComplete="off" />
          )}
        </Field>
        <div>
          <Button type="submit" variant="primary" disabled={connect.isPending}>
            {t("environments.connect")}
          </Button>
        </div>
      </form>
      {command ? (
        <div className="flex flex-col gap-2">
          <h3 id="command-heading" className="text-sm font-semibold">
            {t("environments.commandHeading")}
          </h3>
          <pre className="whitespace-pre-wrap break-all rounded border border-border bg-raised p-3 text-sm">
            <code data-testid="connect-command">{command}</code>
          </pre>
          <p className="text-sm text-fg-muted">{t("environments.commandHint")}</p>
          <div className="flex items-center gap-2">
            <Button onClick={() => void copy()}>{t("environments.copy")}</Button>
            {copied ? (
              <span role="status" className="text-sm text-fg-muted">
                {t("environments.copied")}
              </span>
            ) : null}
            <Button variant="ghost" onClick={() => setCommand(null)}>
              {t("environments.done")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
