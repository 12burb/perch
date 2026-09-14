/**
 * Code mode's Sessions section (task 1.12): the open project's sessions, newest first, and a small
 * form to start one (engine, and the agent or provider when the engine's default is not wanted).
 */
import { Button, Field, Input, SidebarItem, SidebarSection, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, unwrap } from "../lib/api.ts";
import { sessionsQuery } from "../lib/queries.ts";

const ENGINES = ["acp", "opencode", "cli-harness"] as const;

export function SessionsSection(props: {
  workspaceId: string;
  projectId: string;
  activeSessionId: string | null;
  onOpen: (sessionId: string) => void;
}) {
  const sessions = useQuery(sessionsQuery(props.workspaceId, props.projectId));
  const queryClient = useQueryClient();
  const ids = useId();
  const [creating, setCreating] = useState(false);
  const [engine, setEngine] = useState<(typeof ENGINES)[number]>("acp");
  const [agent, setAgent] = useState("");
  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/sessions", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: {
            engine,
            ...(agent.trim() ? { model: { provider: agent.trim(), model_id: "default" } } : {}),
          },
        }),
      ),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({
        queryKey: ["sessions", props.workspaceId, props.projectId],
      });
      setCreating(false);
      setAgent("");
      props.onOpen(created.id);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <SidebarSection title={t("session.title")}>
      <li className="px-2 py-1">
        {creating ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={submit}
            aria-label={t("session.newTitle")}
          >
            <Field id={`${ids}-engine`} label={t("session.engine")}>
              {(control) => (
                <select
                  {...control}
                  className="h-8 w-full rounded border border-border bg-surface px-2 text-sm"
                  value={engine}
                  onChange={(event) => setEngine(event.target.value as (typeof ENGINES)[number])}
                >
                  {ENGINES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              id={`${ids}-agent`}
              label={t("session.agentField")}
              hint={t("session.agentHint")}
            >
              {(control) => (
                <Input
                  {...control}
                  value={agent}
                  onChange={(event) => setAgent(event.target.value)}
                  className="h-8"
                />
              )}
            </Field>
            {create.error ? (
              <p role="alert" className="text-danger text-xs">
                {create.error.message}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={create.isPending}>
                {t("session.start")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={() => setCreating(true)}>
            {t("session.new")}
          </Button>
        )}
      </li>
      {(sessions.data ?? []).length === 0 ? (
        <li className="px-2 py-1 text-fg-subtle text-sm">{t("shell.code.sessionsEmpty")}</li>
      ) : (
        (sessions.data ?? []).map((session) => (
          <SidebarItem
            key={session.id}
            label={session.title ?? t("session.untitled")}
            active={session.id === props.activeSessionId}
            onSelect={() => props.onOpen(session.id)}
            muted={session.status === "ended"}
            trailing={
              session.status === "needs_you" || session.status === "running" ? (
                <span className="text-xs">{t(`session.status.${session.status}`)}</span>
              ) : undefined
            }
          />
        ))
      )}
    </SidebarSection>
  );
}
